'use strict';

// Runs an external review engine (Codex CLI and the like) for a reviewer or refuter prompt. Shared by the task review
// (commands/review.js) and the plan review (commands/plan.js). The prompt goes in on stdin, the engine is read-only
// by its configured args, and it has 15 minutes. Engine output is untrusted: callers sanitize what comes back.
const { spawnSync } = require('child_process');
const execx = require('../core/exec');
const config = require('../core/config');
const json = require('../core/json');
const events = require('../core/events');
const { CrewError } = require('../core/errors');
const { clean } = require('../core/redact');
const rv = require('./review');

const TIMEOUT_MS = 15 * 60 * 1000;

// -> { list } on success, or { fail: { key, vars, reason } } when the engine could not give an array.
// A missing engine name in the global config is a setup error and still throws.
// `input` may be a function: the prompt is built after the engine is known to exist.
// `engineTxt` (a path): where the stdout is kept when it holds no JSON array.
function run({ cwd, name, input, engineTxt }) {
  const eng = config.globalEngines()[name];
  if (!eng || !eng.command) throw new CrewError('wf.review.noEngine', { name });
  const file = execx.resolveCommand(eng.command, { cwd });
  if (!file) {
    return { fail: { key: 'wf.review.engineNotFound', vars: { name, command: eng.command }, reason: clean(`command "${eng.command}" was not found on PATH`, 300) } };
  }
  const plan = execx.spawnPlan(file, eng.args || []);
  const r = spawnSync(plan.file, plan.args, {
    input: typeof input === 'function' ? input() : input, cwd, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...plan.options,
  });
  if (r.error || r.status !== 0) {
    const detail = clean((r.error && r.error.message) || r.stderr || `exit ${r.status}`, 300);
    return { fail: { key: 'wf.review.engineFailed', vars: { name, detail }, reason: detail } };
  }
  const list = rv.extractJsonArray(r.stdout);
  if (!list) {
    if (engineTxt) json.saveRaw(engineTxt, clean(r.stdout, 20000));
    return { fail: { key: 'wf.review.noJson', vars: { name, file: engineTxt || '' }, reason: 'no JSON array in the engine output' } };
  }
  return { list };
}

const fallbackOf = (cfg, role) => (((cfg.roles || {})[role] || {}).fallback === 'none' ? 'none' : 'claude');

// A failed run: throw the old error (fallback "none") or record the fallback and return { engine, reason }.
function onFail(projectId, cfg, { role, name, fail, round, scope, task }) {
  if (fallbackOf(cfg, role) === 'none') throw new CrewError(fail.key, fail.vars);
  const data = { role, engine: name, reason: fail.reason, round, scope };
  events.append(projectId, { type: 'review.engine_fallback', src: 'cli', ...(task ? { task } : {}), data });
  return { engine: name, reason: fail.reason };
}

module.exports = { run, onFail, fallbackOf };
