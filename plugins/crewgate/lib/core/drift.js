'use strict';

// Drift from a final plan: one question with five replies, asked through the gate plan_drift and answered with the user's
// reply (the same user-turn rule as finalize). Nothing here raises the question by itself; later triggers call ask().
//   add    the text becomes a step (origin user)       goal   the text replaces the goal line
//   new    the text names a new draft plan             drop   the text is added to ## Not doing
//   defer  the text becomes a to-do item (stream drift)
// Every answer except a no leaves a line under ## Drift, records plan.drift_answered, and makes the file's current hash the plan's
// approved hash: the user has now seen and answered this difference.
const { CrewError } = require('./errors');
const { clean } = require('./redact');
const events = require('./events');
const gates = require('./gates');
const plans = require('./plans');
const store = require('./store');

const KINDS = ['new-step', 'changed-text', 'unlinked-task', 'out-of-scope'];
const ANSWERS = ['add', 'goal', 'new', 'drop', 'defer'];
const DRIFT_RE = /^##[ \t]+drift[ \t]*$/i;
const HEADING_RE = /^#{1,6}[ \t]/;
const GATE = 'plan_drift';

const askCfg = (cfg) => ({ ...cfg, gates: { ...((cfg && cfg.gates) || {}), [GATE]: 'ask' } });

function one(text) {
  const s = clean(String(text || '').replace(/<!--|-->/g, ' ').replace(/\s+/g, ' ').trim(), 500);
  if (!s) throw new CrewError('plan.noText');
  return s;
}

// Text that would become a heading or a step when written as a line of the plan file. A goal is a bare line, so a heading, a list
// marker or a checkbox breaks it; a line under ## Not doing is written as "- text", so only a heading (when the section is made) or
// a checkbox breaks it. A step's text is kept inside its own "- [ ] text" line and cannot break anything.
const LOOKS_LIKE = {
  goal: /^(?:#|[-*+](?:\s|$)|\d+[.)](?:\s|$)|\[[ xX~?]\])/,
  drop: /^(?:#|\[[ xX~?]\])/,
};
function checkLooks(reply, body) {
  if (LOOKS_LIKE[reply] && LOOKS_LIKE[reply].test(body)) throw new CrewError('plan.driftTextShape', { answer: reply, text: body });
}

function mustBeFinal(root, projectId, slug) {
  const info = plans.stateInfo(root, projectId, slug);
  if (!info) throw new CrewError('plan.notFound', { slug });
  if (info.state !== 'final') throw new CrewError('plan.driftNotFinal', { slug, state: info.state });
}

// ask -> { slug, kind, gate_id }; throws plan.driftNotFinal for a plan that is not final.
function ask(root, projectId, cfg, slug, kind, detail, opts = {}) {
  if (!KINDS.includes(kind)) throw new CrewError('plan.driftBadKind', { kind: String(kind), kinds: KINDS.join(', ') });
  mustBeFinal(root, projectId, slug);
  const g = gates.ask(projectId, askCfg(cfg), { gate: GATE, detail: `drift on plan ${slug} (${kind}): ${clean(String(detail || ''), 300)}` }, { src: 'cli', session: opts.session });
  plans.record(projectId, 'plan.drift_asked', { slug, kind, gate: g.id });
  return { slug, kind, gate_id: g.id };
}

// ---------------------------------------------------------------- the plan file
// A line at the end of the ## Drift section (made at the end of the file when missing); other lines stay as they are.
function addDriftLine(root, slug, line) {
  plans.update(root, slug, (doc) => {
    let at = doc.lines.findIndex((l) => !l.node && DRIFT_RE.test(l.raw));
    if (at < 0) {
      const last = doc.lines[doc.lines.length - 1];
      if (last && (last.node || last.raw.trim())) doc.lines.push({ raw: '' });
      doc.lines.push({ raw: '## Drift' });
      at = doc.lines.length - 1;
    }
    let end = at + 1;
    while (end < doc.lines.length && !doc.lines[end].node && !HEADING_RE.test(doc.lines[end].raw)) end++;
    while (end > at + 1 && !doc.lines[end - 1].node && !doc.lines[end - 1].raw.trim()) end--;
    doc.lines.splice(end, 0, { raw: line });
    doc.final = true;
  });
}

// The goal is the text right under the title (after the state line) and before the first heading or step.
function replaceGoal(root, slug, text) {
  plans.update(root, slug, (doc) => {
    if (doc.titleLine < 0) throw new CrewError('plan.noTitleLine', { slug });
    const idx = [];
    for (let i = doc.titleLine + 1; i < doc.lines.length; i++) {
      const l = doc.lines[i];
      if (l.node || HEADING_RE.test(l.raw)) break;
      if (i !== doc.stateLine && l.raw.trim()) idx.push(i);
    }
    if (idx.length) {
      doc.lines[idx[0]] = { raw: text };
      for (const k of idx.slice(1).reverse()) doc.lines.splice(k, 1);
    } else {
      const at = doc.stateLine >= 0 ? doc.stateLine + 1 : doc.titleLine + 1;
      doc.lines.splice(at, 0, { raw: text });
      const next = doc.lines[at + 1];
      if (next && (next.node || next.raw.trim())) doc.lines.splice(at + 1, 0, { raw: '' });
    }
  });
}

function appendNotDoing(root, projectId, slug, text) {
  const { re } = plans.PARTS['not-doing'];
  if (!plans.readCapped(root, slug).lines.some((l) => !l.node && re.test(l.raw))) { plans.setPart(root, projectId, slug, 'not-doing', text); return; }
  plans.update(root, slug, (doc) => {
    const at = doc.lines.findIndex((l) => !l.node && re.test(l.raw));
    let end = at + 1;
    while (end < doc.lines.length && !doc.lines[end].node && !HEADING_RE.test(doc.lines[end].raw)) end++;
    while (end > at + 1 && !doc.lines[end - 1].raw.trim()) end--;
    doc.lines.splice(end, 0, { raw: `- ${text}` });
  });
}

// ---------------------------------------------------------------- answer
function askedOf(projectId, slug, gateId) {
  const ev = events.read(projectId, { types: ['plan.drift_asked'] }).find((e) => e.data && e.data.gate === String(gateId) && e.data.slug === slug);
  if (!ev) throw new CrewError('plan.driftBadGate', { slug, id: String(gateId) });
  return ev.data;
}

// answer(root, projectId, slug, gateId, reply, text, answerOpts) -> { slug, kind, answer, gate_id, hash }
// answerOpts are built like commands/gate.js builds them. A no (given through `crew gate answer`) changes nothing.
function answer(root, projectId, slug, gateId, reply, text, answerOpts) {
  if (!ANSWERS.includes(reply)) throw new CrewError('plan.driftBadAnswer', { answer: String(reply), answers: ANSWERS.join(', ') });
  const asked = askedOf(projectId, slug, gateId);
  if (events.read(projectId, { types: ['plan.drift_answered'] }).some((e) => e.data && e.data.gate === String(gateId))) {
    throw new CrewError('plan.driftAlreadyAnswered', { id: String(gateId) });
  }
  mustBeFinal(root, projectId, slug);
  const body = one(text);
  checkLooks(reply, body);
  if (reply === 'new') {
    plans.checkSlug(body);
    if (plans.exists(root, body)) throw new CrewError('plan.exists', { slug: body });
  }
  plans.takeReply(projectId, slug, String(gateId), answerOpts);
  if (reply === 'add') plans.addTo(root, projectId, slug, { text: body, origin: 'user' });
  else if (reply === 'goal') replaceGoal(root, slug, body);
  else if (reply === 'new') plans.create(root, projectId, body, { title: body });
  else if (reply === 'drop') appendNotDoing(root, projectId, slug, body);
  else store.workSet(projectId, { stream: 'drift', title: body, state: 'todo', note: `plan ${slug}, ${asked.kind}` });
  addDriftLine(root, slug, `- ${plans.today()} ${asked.kind} ${reply}: ${body}`);
  const hash = plans.fileHash(root, slug);
  plans.writeRecord(projectId, slug, { hash, approved: plans.fileApprovedHash(root, slug) });
  plans.record(projectId, 'plan.drift_answered', { slug, kind: asked.kind, answer: reply, gate: String(gateId) });
  return { slug, kind: asked.kind, answer: reply, gate_id: String(gateId), hash };
}

// ---------------------------------------------------------------- once per kind
// True when this kind was answered on this plan and no user message has come since. The prompt times are the session's, or
// every session's of the project when the session is not known (what commands/gate.js passes to gates.answer).
function covered(root, projectId, slug, kind, session) {
  const last = events.read(projectId, { types: ['plan.drift_answered'] })
    .filter((e) => e.data && e.data.slug === slug && e.data.kind === kind).pop();
  if (!last) return false;
  const sess = require('../hooks/session');
  let prompts;
  const s = session ? sess.read(session) : null;
  if (s && Array.isArray(s.prompt_ts)) prompts = s.prompt_ts; else prompts = sess.promptsOfProject(projectId);
  const from = Date.parse(last.ts);
  return !prompts.some((t) => t > from);
}

// ---------------------------------------------------------------- the triggers
// A step added to a final plan. -> { mode, covered, clean } or null when nothing applies (plan not final, or plan.enforce off).
// mode block with the kind not covered throws plan.driftNewStep (nothing has changed yet); remind returns warn (approveStep records plan.drift_unasked once the step is written).
// `clean` says the file matched what was approved before the step: only then is the new step approved along with it (approveStep).
function stepCheck(root, projectId, cfg, slug, opts = {}) {
  const kind = opts.kind || 'new-step'; // plan edit asks with changed-text
  const mode = cfg && cfg.plan && cfg.plan.enforce;
  if (mode === 'off' || plans.stateOf(root, projectId, slug) !== 'final') return null;
  const isCovered = covered(root, projectId, slug, kind, opts.session);
  const clean0 = !plans.changedSinceApproved(root, projectId, slug);
  if (!isCovered) {
    if (mode === 'remind') {
      return { mode, covered: false, clean: clean0, warn: true, session: opts.session, kind };
    }
    throw new CrewError(kind === 'changed-text' ? 'plan.driftEditStep' : 'plan.driftNewStep', { slug });
  }
  return { mode, covered: true, clean: clean0, kind };
}
// Called after the step was written: under remind, the step went in without the question, so that is recorded now (never for a failed add).
function approveStep(root, projectId, slug, chk) {
  if (chk && chk.warn) {
    try { events.append(projectId, { type: 'plan.drift_unasked', src: 'cli', session: chk.session, data: { slug, kind: chk.kind || 'new-step' }, key: `${slug}:drift_unasked:${Date.now()}` }); } catch { /* ignore */ }
  }
  if (chk && chk.covered && chk.clean) plans.approveNow(root, projectId, slug);
}

// A task created with no plan while a plan is final. -> null when nothing applies (plan.enforce off, or no final plan), else
// { mode, slugs, covered, warn? }. block with unlinked-task not answered on any final plan throws plan.driftUnlinkedTask (no task is
// made yet); remind returns warn (the caller records plan.drift_unasked once the task exists, see noteUnlinked).
function unlinkedCheck(root, projectId, cfg, opts = {}) {
  const mode = cfg && cfg.plan && cfg.plan.enforce;
  if (mode === 'off') return null;
  const open = plans.finalSlugs(root, projectId);
  if (!open.length) return null;
  if (open.some((slug) => covered(root, projectId, slug, 'unlinked-task', opts.session))) return { mode, slugs: open, covered: true };
  if (mode === 'remind') return { mode, slugs: open, covered: false, warn: true, session: opts.session };
  try { events.append(projectId, { type: 'plan.drift_denied', src: 'cli', session: opts.session, data: { slug: open[0], slugs: open, kind: 'unlinked-task' }, key: `unlinked:drift_denied:${Date.now()}` }); } catch { /* ignore */ }
  throw new CrewError('plan.driftUnlinkedTask', { slugs: open.join(', '), slug: open[0] });
}
function noteUnlinked(projectId, chk, taskId) {
  if (!chk || !chk.warn) return;
  try { events.append(projectId, { type: 'plan.drift_unasked', src: 'cli', session: chk.session, task: taskId, data: { slug: chk.slugs[0], slugs: chk.slugs, task: taskId, kind: 'unlinked-task' }, key: `${taskId}:drift_unasked:unlinked` }); } catch { /* ignore */ }
}

// The files of `files` that lie outside a task's scope: a file matching --deny, or any file matching no --allow when --allow is set.
// Paths follow hooks/glob.js (forward slashes; `ci` for a case-insensitive file system, as the edit guard does).
function outsideFiles(scope, files, ci) {
  const glob = require('../hooks/glob');
  const allow = (scope && scope.allow) || [];
  const deny = (scope && scope.deny) || [];
  if (!allow.length && !deny.length) return [];
  return files.filter((f) => glob.matchAny(deny, f, ci) || (allow.length > 0 && !glob.matchAny(allow, f, ci)));
}

// ---------------------------------------------------------------- statistics
// stats(projectId, slug?) -> { plans: [{ slug, asked, answers, by_kind }], outside_plan }
function stats(projectId, slug) {
  const by = new Map();
  const row = (s) => {
    if (!by.has(s)) {
      by.set(s, { slug: s, asked: 0, answers: Object.fromEntries(ANSWERS.map((a) => [a, 0])), by_kind: Object.fromEntries(KINDS.map((k) => [k, { asked: 0, answered: 0 }])) });
    }
    return by.get(s);
  };
  for (const e of events.read(projectId, { types: ['plan.drift_asked', 'plan.drift_answered'] })) {
    const d = e.data || {};
    if (!d.slug || (slug && d.slug !== slug) || !KINDS.includes(d.kind)) continue;
    const r = row(d.slug);
    if (e.type === 'plan.drift_asked') { r.asked++; r.by_kind[d.kind].asked++; } else if (ANSWERS.includes(d.answer)) { r.answers[d.answer]++; r.by_kind[d.kind].answered++; }
  }
  if (slug) row(slug);
  const outside = events.read(projectId, { types: ['task.outside_plan'] }).length;
  return { plans: [...by.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1)), outside_plan: outside };
}

module.exports = { KINDS, ANSWERS, GATE, ask, answer, covered, stepCheck, approveStep, unlinkedCheck, noteUnlinked, outsideFiles, stats };
