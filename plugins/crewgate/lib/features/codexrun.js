'use strict';

// `crew task run <id> --engine codex`: crewgate runs the Codex CLI as a worker in the task's
// worktree and does the git work itself, because Codex's workspace-write sandbox can edit files in
// a linked worktree but cannot commit there (the index lock lives in the main .git folder) and
// cannot write ~/.crewgate. Codex edits files and returns one JSON object; crewgate (outside the
// sandbox) commits, files the report and moves the task. DESIGN section 16.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const config = require('../core/config');
const events = require('../core/events');
const json = require('../core/json');
const paths = require('../core/paths');
const store = require('../core/store');
const tasks = require('../core/tasks');
const execx = require('../core/exec');
const { CrewError } = require('../core/errors');
const { clean } = require('../core/redact');
const common = require('./common');
const init = require('./init');

const DEFAULT_TIMEOUT_S = 1800;
const MAX_LOG = 200 * 1024;
const MAX_DIFF = 400 * 1024;
const TRAILER = 'Co-Authored-By: Codex <noreply@openai.com>';
const FIELDS = ['changes', 'tests', 'assumptions', 'realenv'];

// The JSON Schema handed to `codex exec --output-schema` (strict mode: every key required).
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: FIELDS,
  properties: {
    changes: { type: 'string', description: 'What changed and why, per file (markdown).' },
    tests: { type: 'string', description: 'Tests and checks you ran, with the key output lines.' },
    assumptions: { type: 'string', description: 'Assumptions made and anything unfinished; write "none" if nothing.' },
    realenv: { type: 'string', description: 'What needs a check in a real environment; write "no" if nothing.' },
  },
};

function git(args, cwd, timeout = 120000) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { ok: !r.error && r.status === 0, out: r.stdout || '', err: (r.stderr || '') + (r.error ? r.error.message : '') };
}

// Where the work happens. Creates the worktree (and branch) from the current HEAD when missing.
function ensureWorktree(root, task) {
  const branch = common.checkBranch(task.branch || `crew/${task.id}`);
  const wt = task.worktree
    ? path.resolve(root, task.worktree)
    : path.join(path.dirname(root), `${path.basename(root)}-crew`, task.id);
  if (!paths.isOutside(path.relative(path.resolve(root), wt))) {
    throw new CrewError('wf.task.run.insideRepo', { path: wt });
  }
  if (fs.existsSync(path.join(wt, '.git'))) return { branch, worktree: wt, created: false };
  if (fs.existsSync(wt) && fs.readdirSync(wt).length) throw new CrewError('wf.task.run.worktreeBusy', { path: wt });
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const exists = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root).ok;
  const r = git(exists ? ['worktree', 'add', wt, branch] : ['worktree', 'add', '-b', branch, wt, 'HEAD'], root);
  if (!r.ok) throw new CrewError('wf.task.run.worktreeFailed', { detail: clean(r.err, 300) });
  return { branch, worktree: wt, created: true };
}

// The worker rules: the project's rendered copy when present, else the template rendered from the config.
function workerRules(root, cfg) {
  let text = '';
  try { text = fs.readFileSync(path.join(root, '.claude', 'agents', 'crew-worker.md'), 'utf8'); } catch { /* use the template */ }
  if (!text) text = init.renderAgent('crew-worker', cfg);
  return text.replace(/^﻿/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
}

function buildPrompt(task, cfg, brief, rules, lang, wt) {
  const L = [
    `crew-task: ${task.id}`,
    `You are the crew worker for task ${task.id}: ${task.title}`,
    `Work only in the current directory (worktree ${wt.worktree}, branch ${wt.branch}).`,
  ];
  if (task.scope.allow.length) L.push(`Allowed paths: ${task.scope.allow.join(', ')}`);
  if (task.scope.deny.length) L.push(`Forbidden paths: ${task.scope.deny.join(', ')}`);
  const f = common.fence(brief + rules);
  L.push('', '## Brief', f, brief.trim(), f, '', '## Worker rules', f, rules, f, '',
    '## Overrides for this run (they win over the rules above)',
    '- Edit files only. Do NOT run `git add`, `git commit`, `git push` or any other git command that writes; the sandbox forbids it and crewgate commits your changes after you finish.',
    '- Do NOT call the `crew` command and do not write report or packet files; ignore the parts of the rules that ask for it.',
    '- Run the project checks when they can run in this sandbox; quote their key output lines in `tests`.',
    `- Your final message must be ONE JSON object and nothing else (no code fence, no prose) with exactly these string keys: ${FIELDS.join(', ')}.`,
    `  changes = what changed and why, per file; tests = tests run with key output lines; assumptions = assumptions and unfinished work ("none" if nothing); realenv = what needs a real-environment check ("no" if nothing).`,
    `  Write the values in ${init.LANGUAGE_NAME[lang] || 'English'}, at most ${Math.floor(cfg.limits.report_max_tokens / 2)} tokens in total.`);
  return L.join('\n');
}

// Pulls the report object out of the model's final message (plain JSON, fenced, or wrapped in prose).
function parseFinal(text) {
  const s = String(text || '').replace(/^﻿/, '').trim();
  if (s.startsWith('[')) return null;
  const tries = [s];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) tries.push(fence[1].trim());
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(s.slice(a, b + 1));
  for (const t of tries) {
    let v;
    try { v = JSON.parse(t); } catch { continue; }
    if (v && typeof v === 'object' && !Array.isArray(v) && FIELDS.every((k) => typeof v[k] === 'string' && v[k].trim())) {
      return Object.fromEntries(FIELDS.map((k) => [k, v[k].trim()]));
    }
  }
  return null;
}

// Runs a process without a shell and kills its whole tree on timeout. -> { code, timedOut, stdout, stderr, error }
function runProcess(plan, opts) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(plan.file, plan.args, {
        cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        detached: process.platform !== 'win32', ...plan.options,
      });
    } catch (e) { resolve({ code: null, timedOut: false, stdout: '', stderr: '', error: e }); return; }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    const cap = (cur, d) => (cur.length > 4 * 1024 * 1024 ? cur : cur + d);
    child.stdout.on('data', (d) => { stdout = cap(stdout, d); });
    child.stderr.on('data', (d) => { stderr = cap(stderr, d); });
    const finish = (code, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, timedOut, stdout, stderr, error });
    };
    const kill = () => {
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 10000 });
        else process.kill(-child.pid, 'SIGKILL');
      } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      setTimeout(() => finish(null), 3000).unref();
    }, opts.timeoutMs);
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(code));
  });
}

function shorten(text, max) { return text.length > max ? `${text.slice(0, max - 20).trimEnd()}\n[...cut]` : text; }

// The report text; sections shrink together until it fits the token limit.
function buildReport(fields, headings, branchLine, maxTokens) {
  let f = { ...fields };
  for (let i = 0; i < 12; i++) {
    const text = [
      `## ${headings[0]}`, branchLine, '',
      `## ${headings[1]}`, f.changes, '',
      `## ${headings[2]}`, f.tests, '',
      `## ${headings[3]}`, f.assumptions, '',
      `## ${headings[4]}`, f.realenv, '',
    ].join('\n');
    if (tasks.estimateTokens(text) <= maxTokens) return text;
    f = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, shorten(v, Math.max(80, Math.floor(v.length * 0.7)))]));
  }
  return null;
}

// runCodex(ctx, proj, cfg, task, { engine, model, timeoutS }) -> exit code (printed through ctx)
async function runCodex(ctx, proj, cfg, task, a) {
  const root = proj.path;
  const name = a.engine;
  const eng = config.globalEngines()[name];
  if (!eng || !eng.command) throw new CrewError('wf.review.noEngine', { name });
  const file = execx.resolveCommand(eng.command, { cwd: root });
  if (!file) throw new CrewError('wf.review.engineNotFound', { name, command: eng.command });
  if (!['created', 'dispatched'].includes(task.state)) throw new CrewError('wf.task.run.badState', { id: task.id, state: task.state });
  const lang = cfg.language === 'zh-TW' ? 'zh-TW' : 'en';
  const dir = paths.taskDir(proj.id, task.id);
  const model = a.model || '';

  const wt = ensureWorktree(root, task);
  tasks.setFields(proj.id, task.id, { branch: wt.branch, worktree: wt.worktree });
  if (task.state === 'created') {
    tasks.transition(proj.id, task.id, 'dispatched', { src: 'cli', note: `dispatched by crew task run (${name})`, data: { engine: name, model: model || null, background: false } });
  } else {
    events.append(proj.id, { type: 'task.dispatched', src: 'cli', task: task.id, data: { engine: name, model: model || null, redispatch: true }, key: `${task.id}:run:${Date.now()}` });
  }

  const fail = (kind, detail, extra = '') => {
    const reason = clean(detail, 300);
    try { events.append(proj.id, { type: 'task.failed', src: 'cli', task: task.id, data: { engine: name, kind, reason }, key: `${task.id}:failed:${Date.now()}` }); } catch { /* ignore */ }
    try { store.needAdd(proj.id, `Task ${task.id}: the ${name} worker failed (${kind}): ${reason}. Changes (if any) are left in ${wt.worktree}.`, { src: 'cli' }); } catch { /* ignore */ }
    ctx.err(ctx.t('wf.task.run.failed', { id: task.id, name, kind, detail: reason, worktree: wt.worktree }) + extra);
    return 1;
  };

  // prompt and schema files (the prompt goes in a file: a long multi-line argument does not survive a Windows .cmd shim)
  const brief = tasks.readBrief(proj.id, task.id) || '';
  const promptFile = path.join(dir, 'worker-prompt.md');
  const schemaFile = path.join(dir, 'codex-schema.json');
  const lastFile = path.join(dir, 'codex-last-message.json');
  json.saveRaw(promptFile, buildPrompt(task, cfg, brief, workerRules(root, cfg), lang, wt));
  json.saveRaw(schemaFile, `${JSON.stringify(OUTPUT_SCHEMA, null, 2)}\n`);
  try { fs.rmSync(lastFile, { force: true }); } catch { /* ignore */ }

  const args = ['exec', '-C', wt.worktree, '--sandbox', 'workspace-write', '--skip-git-repo-check',
    '--output-schema', schemaFile, '-o', lastFile];
  if (model) args.push('-m', model);
  args.push(`Read the file ${promptFile} and follow it exactly. Your final message must be the JSON object it asks for.`);
  let plan;
  try { plan = execx.spawnPlan(file, args); } catch (e) { return fail('start', e.message); }

  ctx.err(ctx.t('wf.task.run.started', { id: task.id, name, worktree: wt.worktree, timeout: a.timeoutS }));
  const res = await runProcess(plan, { cwd: wt.worktree, env: process.env, timeoutMs: a.timeoutS * 1000 });
  const log = clean(`# exit ${res.code}${res.timedOut ? ' (timed out)' : ''}\n## stdout\n${res.stdout}\n## stderr\n${res.stderr}\n`, MAX_LOG);
  json.saveRaw(path.join(dir, 'codex.log'), log);

  if (res.timedOut) return fail('timeout', `no answer within ${a.timeoutS} s`);
  if (res.error) return fail('start', res.error.message);
  if (res.code !== 0) return fail('exit', `exit code ${res.code}: ${clean(res.stderr || res.stdout, 200)}`);

  let raw = '';
  try { raw = fs.readFileSync(lastFile, 'utf8'); } catch { raw = ''; }
  let fields = parseFinal(raw);
  if (!fields) fields = parseFinal(res.stdout);
  if (!fields) return fail('output', `the final message is missing or not the expected JSON (see ${path.join(dir, 'codex.log')})`);

  const status = git(['status', '--porcelain'], wt.worktree);
  if (!status.ok) return fail('git', status.err);
  if (!status.out.trim()) return fail('no-changes', 'the worker changed no files');
  const nameR = git(['config', 'user.name'], wt.worktree).out.trim();
  const mailR = git(['config', 'user.email'], wt.worktree).out.trim();
  if (!nameR || !mailR) return fail('commit', 'git user.name / user.email are not configured for this repository');
  const add = git(['add', '-A'], wt.worktree);
  if (!add.ok) return fail('commit', add.err);
  const files = git(['diff', '--cached', '--name-only'], wt.worktree).out.split(/\r?\n/).filter(Boolean);
  const commit = git(['commit', '-q', '-m', task.title, '-m', `Crew task ${task.id}, implemented by the ${name} worker.`, '-m', TRAILER], wt.worktree);
  if (!commit.ok) return fail('commit', commit.err);
  const sha = git(['rev-parse', '--short', 'HEAD'], wt.worktree).out.trim();

  const range = common.branchRange(root, wt.branch);
  const diff = range ? git(['diff', range.base, wt.branch], root).out : git(['show', '--format=', 'HEAD'], wt.worktree).out;
  const branchLine = `${wt.branch} ${sha} (committed by crewgate; engine ${name}${model ? `, model ${model}` : ''})`;
  const report = buildReport(fields, init.HEADINGS[lang], branchLine, cfg.limits.report_max_tokens);
  if (!report) return fail('report', 'the report does not fit the token limit');
  const packet = ['# Packet', '', '## Raw model output', '```json', raw.trim() || res.stdout.trim(), '```', '', '## Diff', '```diff', shorten(diff, MAX_DIFF), '```', ''].join('\n');
  const { task: done, tokens } = tasks.recordReport(proj.id, task.id, { report, packet }, {
    src: 'cli', maxTokens: cfg.limits.report_max_tokens, note: `returned by crew task run (${name})`, data: { engine: name, commit: sha, files: files.length },
  });
  const line = ctx.t('wf.task.run.done', { id: done.id, name, n: files.length, sha, branch: wt.branch, tokens });
  ctx.emit({ task: done, engine: name, branch: wt.branch, worktree: wt.worktree, commit: sha, files, tokens }, line);
  return 0;
}

module.exports = { runCodex, parseFinal, buildReport, OUTPUT_SCHEMA, TRAILER, DEFAULT_TIMEOUT_S };
