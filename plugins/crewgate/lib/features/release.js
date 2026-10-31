'use strict';

// Release record: gathers what went into a version (tasks, review rounds, plans, gates) from the project's
// own data and git (read-only), and renders it as Markdown. Nothing is written here.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CrewError } = require('../core/errors');
const { redact, clean } = require('../core/redact');
const { t } = require('../core/i18n');
const events = require('../core/events');
const tasks = require('../core/tasks');
const plans = require('../core/plans');
const paths = require('../core/paths');
const rv = require('./review');
const common = require('./common');

const OPEN = '<!-- crew:conclusion -->';
const CLOSE = '<!-- /crew:conclusion -->';
const HEX_RE = /\b[0-9a-f]{7,40}\b/g;

// ---------------------------------------------------------------- git (read-only)
const gitOut = (root, args) => {
  const o = common.git(args, root);
  return o === null ? null : o.trim();
};

function resolveCommit(root, ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-')) return null;
  return gitOut(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) || null;
}

// -> { from, to, fromSha, toSha, commits:Set, fromDate, toDate }. Throws CrewError release.badRef.
function resolveRange(root, version, opts = {}) {
  const tag = `v${version}`;
  const to = opts.to || (resolveCommit(root, `refs/tags/${tag}`) ? tag : 'HEAD');
  const toSha = resolveCommit(root, to);
  if (!toSha) throw new CrewError('release.badRef', { ref: String(to) });
  let from = opts.from || null;
  let fromSha = null;
  if (from) {
    fromSha = resolveCommit(root, from);
    if (!fromSha) throw new CrewError('release.badRef', { ref: String(from) });
  } else {
    const name = gitOut(root, ['describe', '--tags', '--abbrev=0', `--exclude=${tag}`, toSha]);
    if (name) { from = name; fromSha = resolveCommit(root, name); }
  }
  const spec = fromSha ? `${fromSha}..${toSha}` : toSha;
  const list = gitOut(root, ['rev-list', spec]);
  const commits = new Set((list || '').split(/\r?\n/).filter(Boolean));
  const dateOf = (sha) => {
    const d = sha ? Date.parse(gitOut(root, ['log', '-1', '--format=%cI', sha]) || '') : NaN;
    return Number.isNaN(d) ? null : d;
  };
  return { from, to, fromSha, toSha, commits, fromDate: dateOf(fromSha), toDate: dateOf(toSha) };
}

// ---------------------------------------------------------------- tasks
const lastOf = (list) => list[list.length - 1];

// Which merged tasks belong to the range. -> { included:[{task, merge}], notPlaced:[id] }
function pickTasks(root, projectId, range, evs) {
  const mergedEv = new Map();
  for (const e of evs) if (e.type === 'task.merged' && e.task) mergedEv.set(e.task, e);
  const included = [];
  const notPlaced = [];
  for (const task of tasks.list(projectId, { state: 'merged' })) {
    const ev = mergedEv.get(task.id) || null;
    const note = ev && ev.data && typeof ev.data.note === 'string' ? ev.data.note : '';
    let placed = false;
    for (const tok of note.match(HEX_RE) || []) {
      const sha = resolveCommit(root, tok);
      if (sha && range.commits.has(sha)) { placed = true; break; }
    }
    if (!placed && task.branch) {
      const tip = resolveCommit(root, `refs/heads/${task.branch}`);
      if (tip && range.commits.has(tip)) placed = true;
    }
    if (placed) { included.push({ task, merge: ev }); continue; }
    const at = ev ? Date.parse(ev.ts) : NaN;
    if (!Number.isNaN(at) && range.toDate !== null && at <= range.toDate && (range.fromDate === null || at > range.fromDate)) notPlaced.push(task.id);
  }
  const key = (x) => (x.merge ? x.merge.ts : '');
  included.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.task.id < b.task.id ? -1 : 1));
  return { included, notPlaced: notPlaced.sort() };
}

function readList(file) { try { return rv.readArray(file, 'findings'); } catch { return null; } }

function roundNumbers(dir) {
  let names = [];
  try { names = fs.readdirSync(rv.findingsDir(dir)); } catch { return []; }
  const set = new Set();
  for (const n of names) { const m = /^(\d+)\./.exec(n); if (m) set.add(Number(m[1])); }
  return [...set].sort((a, b) => a - b);
}

function describeRound(dir, round) {
  const raw = readList(rv.roundFile(dir, round, 'raw.json'));
  const kept = readList(rv.roundFile(dir, round, 'kept.json'));
  const final = readList(rv.roundFile(dir, round, 'json'));
  const filtered = readList(rv.roundFile(dir, round, 'filtered.json')) || [];
  const refs = readList(rv.roundFile(dir, round, 'refutations.json')) || [];
  const keptIds = new Set((kept || []).map((f) => f && f.id));
  const verdicts = { upheld: 0, refuted: 0, uncertain: 0 };
  for (const r of refs) if (r && keptIds.has(r.id) && verdicts[r.verdict] !== undefined) verdicts[r.verdict]++;
  return {
    round,
    finalized: final !== null,
    raw: raw ? raw.length : 0,
    kept: kept ? kept.length : 0,
    ...verdicts,
    dismissed: filtered.filter((d) => d && d.reason === 'dismissed').length,
    findings: (final || []).map((f) => ({
      id: f.id, severity: f.severity, category: f.category, file: f.file, line: f.line, claim: f.claim, verdict: f.verdict || '',
    })),
  };
}

// When a round was finalized: the "review round N" event when there is one, else the file's modification time.
function finalizedAt(dir, round, taskEvs) {
  const hit = taskEvs.filter((e) => e.type === 'task.reviewed' && e.data && e.data.note === `review round ${round}`);
  if (hit.length) return Date.parse(lastOf(hit).ts);
  try { return fs.statSync(rv.roundFile(dir, round, 'json')).mtimeMs; } catch { return 0; }
}

function describeTask(projectId, entry, evs, allPlans) {
  const { task, merge } = entry;
  const dir = paths.taskDir(projectId, task.id);
  const mine = evs.filter((e) => e.task === task.id);
  const rounds = roundNumbers(dir).map((n) => describeRound(dir, n)).filter((r) => r.raw || r.kept || r.finalized);
  const finals = rounds.filter((r) => r.finalized);
  let review;
  if (!finals.length) review = { kind: 'none' };
  else {
    const last = lastOf(finals);
    const at = finalizedAt(dir, last.round, mine);
    const after = mine.filter((e) => e.type === 'task.returned' && Date.parse(e.ts) > at);
    review = after.length ? { kind: 'stale', round: last.round } : { kind: 'ok', round: last.round };
  }
  const skips = mine.filter((e) => e.type === 'task.accepted' && e.data && e.data.skip_refuter)
    .map((e) => ({ reason: String(e.data.skip_refuter), round: e.data.review_gap && e.data.review_gap.round }));
  const dismissals = mine.filter((e) => e.type === 'review.finding_dismissed' && e.data)
    .map((e) => ({ finding: e.data.finding, scope: e.data.scope, category: e.data.category, file: e.data.file, reason: e.data.reason }));
  const followups = [];
  for (const p of allPlans) {
    for (const n of p.doc.nodes) if (n.meta.from_task === task.id) followups.push({ plan: p.slug, node: n.meta.id || `L${n.lineNo}`, text: n.text, state: plans.BOX_STATE[n.box] });
  }
  return {
    id: task.id, title: task.title, branch: task.branch || '', returns: task.returns || 0,
    merged_commit: merge && merge.data ? merge.data.note || '' : '',
    review, rounds, skip_refuter: skips, dismissals, follow_ups: followups,
  };
}

// ---------------------------------------------------------------- plans
function parseClarified(line) {
  const m = /^Q:\s*([\s\S]*?)\s+A:\s*([\s\S]*?)\s*\((user|assumed)\)\s*$/.exec(line);
  return m ? { question: m[1], answer: m[2], by: m[3] } : { question: '', answer: line, by: '' };
}

function describePlan(slug, doc, stateOf) {
  const d = plans.derive(doc, stateOf);
  return {
    slug, title: d.title, goal: d.goal, done: d.summary.done, total: d.summary.total, pct: d.summary.pct,
    clarified: d.clarified.map(parseClarified),
  };
}

// ---------------------------------------------------------------- gates
function pickGates(evs, range, includedIds) {
  const inWindow = (e) => {
    const at = Date.parse(e.ts);
    return !Number.isNaN(at) && (range.fromDate === null || at > range.fromDate) && (range.toDate === null || at <= range.toDate);
  };
  const byId = new Map();
  const order = [];
  const missing = [];
  for (const e of evs) {
    if (!e.type.startsWith('gate.')) continue;
    const mineTask = e.task && includedIds.has(e.task);
    if (!(mineTask || (!e.task && inWindow(e)))) continue;
    const d = e.data || {};
    if (e.type === 'gate.missing') { missing.push({ gate: d.gate || '', command: d.command || '', task: e.task || '' }); continue; }
    if (e.type !== 'gate.asked' && e.type !== 'gate.answered') continue;
    const id = d.id || `${e.type}:${e.ts}`;
    if (!byId.has(id)) { byId.set(id, { id, gate: d.gate || '', detail: '', task: e.task || '', answer: null, user_turn: null, auto: false }); order.push(id); }
    const g = byId.get(id);
    if (e.type === 'gate.asked') { g.detail = d.detail || ''; g.gate = d.gate || g.gate; } else { g.answer = d.answer || ''; g.user_turn = d.user_turn !== false; g.auto = !!d.auto; g.gate = g.gate || d.gate || ''; }
  }
  return { gates: order.map((id) => byId.get(id)), missing };
}

// ---------------------------------------------------------------- collect
// collect({ root, projectId, version, from, to, plans:[slug] }) -> plain data object (no timestamps of its own)
function collect(o) {
  const range = resolveRange(o.root, o.version, { from: o.from, to: o.to });
  const evs = events.read(o.projectId);
  const { included, notPlaced } = pickTasks(o.root, o.projectId, range, evs);
  const allPlans = [];
  for (const slug of plans.slugs(o.root)) {
    const doc = plans.readCapped(o.root, slug);
    if (doc) allPlans.push({ slug, doc });
  }
  const ids = new Set(included.map((x) => x.task.id));
  const wanted = new Set(o.plans || []);
  for (const s of wanted) if (!allPlans.some((p) => p.slug === s)) throw new CrewError('plan.notFound', { slug: s });
  for (const p of allPlans) {
    if (p.doc.nodes.some((n) => n.meta.task && ids.has(n.meta.task))) wanted.add(p.slug);
  }
  const stateOf = plans.taskStates(o.projectId);
  return {
    version: o.version,
    range: { from: range.from, to: range.to, from_sha: range.fromSha, to_sha: range.toSha, commits: range.commits.size },
    tasks: included.map((x) => describeTask(o.projectId, x, evs, allPlans)),
    not_placed: notPlaced,
    plans: allPlans.filter((p) => wanted.has(p.slug)).map((p) => describePlan(p.slug, p.doc, stateOf)),
    ...pickGates(evs, range, ids),
  };
}

// ---------------------------------------------------------------- render
const one = (s, n) => clean(String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim(), n);
const short = (sha) => (sha ? sha.slice(0, 7) : '');

function renderTask(L, tr, k) {
  L.push('', `### ${k.id} - ${one(k.title, 200)}`, '');
  L.push(`- ${tr('release.branch')}: \`${k.branch || '-'}\`${k.merged_commit ? ` (${tr('release.mergedAs')} \`${k.merged_commit}\`)` : ''}`);
  L.push(`- ${tr('release.returns')}: ${k.returns}`);
  L.push(`- ${tr('release.rounds')}: ${k.rounds.filter((r) => r.finalized).length}`);
  if (k.review.kind === 'none') L.push(`- **${tr('release.noReview')}**`);
  else if (k.review.kind === 'stale') L.push(`- **${tr('release.stale', { round: k.review.round })}**`);
  for (const r of k.rounds) {
    const counts = tr('release.counts', { raw: r.raw, kept: r.kept, upheld: r.upheld, refuted: r.refuted, uncertain: r.uncertain, dismissed: r.dismissed });
    if (!r.finalized) { L.push(`- ${tr('release.roundOpen', { round: r.round })} ${counts}`); continue; }
    L.push(`- ${tr(r.findings.length ? 'release.roundHead' : 'release.roundZero', { round: r.round, n: r.findings.length })} ${counts}`);
    for (const f of r.findings) {
      L.push(`  - ${f.severity} ${f.category} \`${f.file}:${f.line}\` ${one(f.claim, 300)} (${f.verdict || '-'})`);
    }
  }
  for (const d of k.dismissals) L.push(`- ${tr('release.dismissed', { finding: d.finding, scope: d.scope })} ${d.category} \`${d.file}\`: ${one(d.reason, 300)}`);
  for (const f of k.follow_ups) L.push(`- ${tr('release.followup', { plan: f.plan, node: f.node, state: f.state })}: ${one(f.text, 300)}`);
  for (const s of k.skip_refuter) L.push(`- **${tr('release.skipRefuter')}**: ${one(s.reason, 300)}`);
}

function renderPlan(L, tr, p) {
  L.push('', `### ${p.slug} - ${one(p.title, 200)}`, '');
  if (p.goal) L.push(`- ${tr('release.goal')}: ${one(p.goal, 600)}`);
  L.push(`- ${tr('release.completion')}: ${p.done}/${p.total} (${p.pct}%)`);
  if (p.clarified.length) L.push(`- ${tr('release.clarified')}:`);
  for (const c of p.clarified) {
    const text = c.question ? `Q: ${one(c.question, 400)} A: ${one(c.answer, 400)}` : one(c.answer, 800);
    L.push(`  - ${text}${c.by === 'assumed' ? ` **(assumed)** - ${tr('release.assumed')}` : ''}`);
  }
}

function renderGates(L, tr, data) {
  for (const g of data.gates) {
    const detail = g.detail ? ` - ${one(g.detail, 300)}` : '';
    let verdict;
    if (g.answer === null) verdict = `**${tr('release.noAnswer')}**`;
    else {
      verdict = `${tr('release.answer')}: ${g.answer || '-'}${g.auto ? ` (${tr('release.auto')})` : ''}`;
      verdict += g.user_turn === false ? `; **${tr('release.noUserTurn')}**` : `; ${tr('release.userTurn')}: ${g.auto ? '-' : 'yes'}`;
    }
    L.push(`- \`${g.gate}\`${g.task ? ` (${g.task})` : ''}${detail} - ${verdict}`);
  }
  for (const m of data.missing) L.push(`- **${tr('release.missing', { gate: m.gate })}**${m.command ? `: \`${one(m.command, 120)}\`` : ''}${m.task ? ` (${m.task})` : ''}`);
  if (!data.gates.length && !data.missing.length) L.push(`- ${tr('release.noGates')}`);
}

// render(data, lang, conclusion) -> Markdown text (not yet redacted)
function render(data, lang, conclusion) {
  const tr = (key, vars) => t(lang, key, vars);
  const L = [`# ${tr('release.title', { version: data.version })}`, ''];
  const r = data.range;
  L.push(tr('release.range', { from: r.from ? `${r.from} (${short(r.from_sha)})` : tr('release.startOfHistory'), to: `${r.to} (${short(r.to_sha)})`, n: r.commits }));
  L.push('', `## ${tr('release.conclusion')}`, '', OPEN, conclusion, CLOSE);
  L.push('', `## ${tr('release.tasks')}`);
  if (!data.tasks.length) L.push('', tr('release.noTasks'));
  for (const k of data.tasks) renderTask(L, tr, k);
  if (data.not_placed.length) L.push('', `${tr('release.notPlaced')}: ${data.not_placed.join(', ')}`);
  L.push('', `## ${tr('release.plans')}`);
  if (!data.plans.length) L.push('', tr('release.noPlans'));
  for (const p of data.plans) renderPlan(L, tr, p);
  L.push('', `## ${tr('release.gates')}`, '');
  renderGates(L, tr, data);
  return `${L.join('\n')}\n`;
}

// ---------------------------------------------------------------- redaction and paths
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function pathRe(dir) {
  const parts = path.resolve(dir).split(/[\\/]+/).filter(Boolean).map(esc);
  const lead = /^[\\/]/.test(path.resolve(dir)) ? '[\\\\/]+' : '';
  return new RegExp(`${lead}${parts.join('[\\\\/]+')}(?=$|[\\\\/\\s"'\`)\\],;:])`, 'gi');
}

// The project's redaction does not cover email addresses; the record may be public, so they are replaced here (example.com stays).
const EMAIL_RE = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;

// Home becomes "~", absolute paths inside the repo become relative, then the project's redaction runs on the whole text.
function sanitize(text, root) {
  let s = text;
  s = s.replace(new RegExp(`${pathRe(root).source}[\\\\/]+`, 'gi'), '').replace(pathRe(root), '.');
  s = s.replace(pathRe(os.homedir()), '~');
  s = redact(s);
  return s.replace(EMAIL_RE, (m, domain) => (/^example\.com$/i.test(domain) ? m : '<email>'));
}

// ---------------------------------------------------------------- conclusion
function extractConclusion(text) {
  const a = text.indexOf(OPEN);
  const b = a < 0 ? -1 : text.indexOf(CLOSE, a + OPEN.length);
  if (a < 0 || b < 0) return null;
  return text.slice(a + OPEN.length, b).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

module.exports = { collect, render, sanitize, extractConclusion, resolveRange, OPEN, CLOSE };
