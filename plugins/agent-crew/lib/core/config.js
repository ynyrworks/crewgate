'use strict';

// Project config (<repo>/.claude/crew.json) and global config (~/.agent-crew/config.json).
// SCHEMA / GLOBAL_SCHEMA drive validation and the board's Settings form.
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const json = require('./json');
const project = require('./project');
const events = require('./events');
const { CrewError } = require('./errors');

const DEFAULTS = Object.freeze({
  version: 1,
  language: 'en',
  roles: {
    orchestrator: { engine: 'claude', model: 'inherit' },
    worker: { engine: 'claude', model: 'sonnet', agent: 'crew-worker' },
    reviewer: { engine: 'claude', model: 'sonnet', agent: 'crew-reviewer' },
    refuter: { engine: 'claude', model: 'sonnet', agent: 'crew-refuter' },
  },
  gates: {
    push: 'ask', open_pr: 'ask', merge: 'ask', remote_hosts: 'ask', large_task: 'ask', install_or_download: 'ask',
  },
  limits: {
    max_parallel_workers: 3,
    max_returns_before_takeover: 2,
    report_max_tokens: 1500,
    orchestrator_read_warn_lines: 300,
    orchestrator_edit: 'warn',
    orchestrator_edit_allow: ['**/*.md', 'docs/**', '.claude/**', '.crew/**'],
  },
  review: {
    min_confidence: 0.6,
    report_inference: false,
    nit_cap: 5,
    categories: ['correctness', 'security-exploitable', 'data-loss', 'regression',
      'spec-mismatch', 'test-gap', 'maintainability', 'nit'],
    downgrade_to_nit: ['theoretical-race', 'style'],
  },
  checks: [],
  forbidden: { paths: [], actions: [] },
  board: { enabled: true, port: 8781 },
  lessons: { promote_after_days: 3, rules_cap: 15, rules_file: 'CLAUDE.md' },
});

const GLOBAL_DEFAULTS = Object.freeze({
  version: 1,
  language: 'en',
  port: 8781,
  usage_days: 14,
  prices: {},
  board: { show_text: false },
  engines: {
    codex: { command: 'codex', args: ['exec', '-s', 'read-only', '--skip-git-repo-check', '-'] },
  },
});

const GATE = ['auto', 'ask', 'never'];
const GATE_DESC = {
  en: 'What to do before this action: auto (just do it), ask (ask the user in chat first) or never.',
  'zh-TW': '執行此動作前的處理方式：auto（直接做）、ask（先在對話中問使用者）、never（禁止）。',
};

// Field description: path ("*" matches any key of a map), type, optional enum/min/max/itemType,
// default (from DEFAULTS where it exists) and a description in en and zh-TW.
function f(p, type, desc, extra = {}) {
  return { path: p, type, description: desc, ...extra };
}
const d = (en, zh) => ({ en, 'zh-TW': zh });

const SCHEMA = [
  f('version', 'integer', d('Config format version.', '設定檔格式版本。'), { enum: [1] }),
  f('language', 'string', d('Language of CLI output and generated files.', 'CLI 輸出與產生檔案的語言。'), { enum: ['en', 'zh-TW'] }),
  f('roles', 'object', d('Role map; add your own roles next to the built-in ones.', '角色對照表；可在內建角色之外自行新增。')),
  f('roles.*', 'object', d('One role.', '單一角色。')),
  f('roles.*.engine', 'string', d('"claude" or the name of an engine defined in the global config (engines are never read from this file).', '"claude" 或全域設定中定義的引擎名稱（引擎定義不會從此檔讀取）。')),
  f('roles.*.model', 'string', d('inherit, opus, sonnet, haiku or a full model id.', 'inherit、opus、sonnet、haiku 或完整模型 ID。')),
  f('roles.*.agent', 'string', d('Agent name used for this role.', '此角色使用的 agent 名稱。')),
  f('gates', 'object', d('Approval gates.', '核准關卡。')),
  ...['push', 'open_pr', 'merge', 'remote_hosts', 'large_task', 'install_or_download']
    .map((k) => f(`gates.${k}`, 'string', GATE_DESC, { enum: GATE })),
  f('limits', 'object', d('Limits and guards.', '限制與守門。')),
  f('limits.max_parallel_workers', 'integer', d('Most workers running at once.', '同時進行的 worker 上限。'), { min: 1, max: 20 }),
  f('limits.max_returns_before_takeover', 'integer', d('Send-backs allowed before the orchestrator takes the task over.', '退回幾次後改由統籌接手。'), { min: 1, max: 20 }),
  f('limits.report_max_tokens', 'integer', d('Maximum worker report size (estimated as characters / 4).', 'worker 報告長度上限（以字元數 / 4 估算）。'), { min: 100, max: 20000 }),
  f('limits.orchestrator_read_warn_lines', 'integer', d('Warn when the orchestrator reads a file longer than this without a range.', '統籌不帶範圍讀超過此行數的檔案時提醒。'), { min: 1, max: 100000 }),
  f('limits.orchestrator_edit', 'string', d('What happens when the orchestrator edits code itself.', '統籌自己改程式時的處理。'), { enum: ['off', 'warn', 'block'] }),
  f('limits.orchestrator_edit_allow', 'array', d('Globs the orchestrator may edit directly.', '統籌可直接修改的路徑 glob。'), { itemType: 'string' }),
  f('review', 'object', d('Review pipeline settings.', '審查流程設定。')),
  f('review.min_confidence', 'number', d('Findings below this confidence are dropped.', '低於此信心的發現會被濾掉。'), { min: 0, max: 1 }),
  f('review.report_inference', 'boolean', d('Keep findings that are only inference.', '保留只憑推論的發現。')),
  f('review.nit_cap', 'integer', d('Most nit findings shown.', '最多顯示幾筆瑣碎意見。'), { min: 0, max: 100 }),
  f('review.categories', 'array', d('Allowed finding categories.', '允許的發現類別。'), { itemType: 'string' }),
  f('review.downgrade_to_nit', 'array', d('Patterns downgraded to nit.', '自動降為瑣碎意見的型態。'), { itemType: 'string' }),
  f('checks', 'array', d('Commands a worker must run before reporting.', 'worker 回報前必須執行的指令。'), { itemType: 'string' }),
  f('forbidden', 'object', d('Boundaries rendered into the worker agent file.', '寫進 worker agent 檔的禁止事項。')),
  f('forbidden.paths', 'array', d('Paths a worker must not touch.', 'worker 不可碰的路徑。'), { itemType: 'string' }),
  f('forbidden.actions', 'array', d('Actions a worker must not take.', 'worker 不可做的動作。'), { itemType: 'string' }),
  f('board', 'object', d('Local board.', '本機看板。')),
  f('board.enabled', 'boolean', d('Enable the board.', '啟用看板。')),
  f('board.port', 'integer', d('Board port on 127.0.0.1.', '看板在 127.0.0.1 的連接埠。'), { min: 1024, max: 65535 }),
  f('lessons', 'object', d('Lessons and promoted rules.', '經驗與升格規則。')),
  f('lessons.promote_after_days', 'integer', d('Distinct days a lesson key must be seen before it is suggested.', '同一經驗出現在幾個不同日子後才建議升格。'), { min: 1, max: 365 }),
  f('lessons.rules_cap', 'integer', d('Most promoted rules kept.', '升格規則數量上限。'), { min: 1, max: 200 }),
  f('lessons.rules_file', 'string', d('File that holds the promoted-rules block. Must be inside the project folder.', '存放升格規則區塊的檔案，必須位於專案資料夾內。')),
];

const GLOBAL_SCHEMA = [
  f('version', 'integer', d('Config format version.', '設定檔格式版本。'), { enum: [1] }),
  f('language', 'string', d('Default language.', '預設語言。'), { enum: ['en', 'zh-TW'] }),
  f('port', 'integer', d('Default board port.', '看板預設連接埠。'), { min: 1024, max: 65535 }),
  f('usage_days', 'integer', d('Days shown on the Usage page.', '用量頁顯示的天數。'), { min: 1, max: 365 }),
  f('prices', 'object', d('Price per million tokens by model name.', '各模型每百萬 token 單價。')),
  f('prices.*', 'object', d('One model.', '單一模型。')),
  f('prices.*.input', 'number', d('Input price.', '輸入單價。'), { min: 0 }),
  f('prices.*.output', 'number', d('Output price.', '輸出單價。'), { min: 0 }),
  f('prices.*.cache_write', 'number', d('Cache write price.', '快取寫入單價。'), { min: 0 }),
  f('prices.*.cache_read', 'number', d('Cache read price.', '快取讀取單價。'), { min: 0 }),
  f('engines', 'object', d('External review engines (for example a Codex CLI reviewer). Defined only here, never in a project: a project can only name an engine in roles.*.engine.', '外部審查引擎（例如 Codex CLI）。只能定義在這裡，專案設定無法定義；專案只能在 roles.*.engine 以名稱引用。')),
  f('engines.*', 'object', d('One engine.', '單一引擎。')),
  f('engines.*.command', 'string', d('Executable to run (resolved through PATH; on Windows .cmd and .bat files work too).', '要執行的程式（依 PATH 尋找；Windows 也支援 .cmd 與 .bat）。')),
  f('engines.*.args', 'array', d('Arguments; the prompt is passed on stdin.', '參數；提示內容由標準輸入傳入。'), { itemType: 'string' }),
  f('board', 'object', d('Board display options.', '看板顯示選項。')),
  f('board.show_text', 'boolean', d('Show a short redacted snippet of the last assistant message in the Sessions list.', '在工作階段清單顯示最後一則助理訊息的簡短（已遮罩）片段。')),
];

// ---------------------------------------------------------------- helpers
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? v : structuredClone(v));

function getPath(obj, p) {
  let cur = obj;
  for (const k of p.split('.')) {
    if (!isObj(cur) || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return clone(cur);
}

function setPath(obj, p, value) {
  const keys = p.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isObj(cur[keys[i]])) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  if (value === undefined) delete cur[keys[keys.length - 1]];
  else cur[keys[keys.length - 1]] = value;
}

// Objects merge recursively; arrays and scalars from `over` replace.
function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return clone(over === undefined ? base : over);
  const out = clone(base);
  for (const [k, v] of Object.entries(over)) {
    if (k === '__proto__') continue; // an own "__proto__" key from JSON.parse must not become the prototype
    out[k] = Object.prototype.hasOwnProperty.call(out, k) && isObj(out[k]) && isObj(v) ? deepMerge(out[k], v) : clone(v);
  }
  return out;
}

// Concrete paths that match a schema path with "*" wildcards: [{ path, value }] (existing keys only).
function expand(obj, schemaPath) {
  let level = [{ path: '', value: obj }];
  for (const seg of schemaPath.split('.')) {
    const next = [];
    for (const { path: pth, value } of level) {
      if (!isObj(value)) continue;
      const keys = seg === '*' ? Object.keys(value) : (seg in value ? [seg] : []);
      for (const k of keys) next.push({ path: pth ? `${pth}.${k}` : k, value: value[k] });
    }
    level = next;
  }
  return level;
}

function typeOk(type, v) {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'boolean': return typeof v === 'boolean';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'array': return Array.isArray(v);
    case 'object': return isObj(v);
    default: return true;
  }
}

function checkAgainst(obj, schema) {
  const errors = [];
  const bad = (p, key, vars) => errors.push({ path: p, key, vars, message: require('./i18n').t('en', key, { path: p, ...vars }) });
  if (!isObj(obj)) {
    bad('', 'config.err.notObject', {});
    return errors;
  }
  for (const entry of schema) {
    for (const { path: p, value } of expand(obj, entry.path)) {
      if (!typeOk(entry.type, value)) { bad(p, 'config.err.type', { type: entry.type }); continue; }
      if (entry.enum && !entry.enum.includes(value)) bad(p, 'config.err.enum', { values: entry.enum.join(', ') });
      if (typeof value === 'number') {
        if (entry.min !== undefined && value < entry.min) bad(p, 'config.err.min', { min: entry.min });
        if (entry.max !== undefined && value > entry.max) bad(p, 'config.err.max', { max: entry.max });
      }
      if (entry.type === 'string' && value === '' && !entry.enum) bad(p, 'config.err.empty', {});
      if (entry.itemType && Array.isArray(value)) {
        value.forEach((x, i) => { if (!typeOk(entry.itemType, x)) bad(`${p}[${i}]`, 'config.err.type', { type: entry.itemType }); });
      }
    }
  }
  return errors;
}

for (const e of SCHEMA) e.default = getPath(DEFAULTS, e.path);
for (const e of GLOBAL_SCHEMA) e.default = getPath(GLOBAL_DEFAULTS, e.path);

// ---------------------------------------------------------------- project config
// validate(obj) -> [{ path, message, key, vars }]; unknown keys are allowed.
// Engine definitions come from the global config only; `root` (optional) anchors lessons.rules_file.
function validate(obj, root) {
  const errors = checkAgainst(obj, SCHEMA);
  const bad = (p, key, vars) => errors.push({ path: p, key, vars, message: require('./i18n').t('en', key, { path: p, ...vars }) });
  if (isObj(obj)) {
    const engines = globalEngines();
    for (const { path: p, value } of expand(obj, 'lessons.rules_file')) {
      if (typeof value === 'string' && value !== '' && !insideRoot(root, value)) bad(p, 'config.err.rulesFile', { value });
    }
    for (const { path: p, value } of expand(obj, 'roles.*.engine')) {
      if (typeof value === 'string' && value !== 'claude' && !(value in engines)) {
        errors.push({ path: p, key: 'config.err.engine', vars: { value }, message: require('./i18n').t('en', 'config.err.engine', { path: p, value }) });
      }
    }
  }
  return errors;
}

// Is `file` (relative, or absolute) inside the project root? Without a root only a lexical check runs.
function insideRoot(root, file) {
  const base = path.resolve(root || process.cwd());
  return !paths.isOutside(path.relative(base, path.resolve(base, file)));
}

function globalEngines() {
  const e = loadGlobal().config.engines;
  return isObj(e) ? e : {};
}

function configFile(root) { return paths.projectConfigFile(root); }

// load(root) -> { config, errors, file, exists }. Never throws: a missing, unreadable or invalid
// file gives defaults (invalid fields fall back to their default); `errors` names file and field.
function load(root) {
  const file = configFile(root);
  const res = { config: clone(DEFAULTS), errors: [], warnings: [], file, exists: false };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') res.errors.push({ file, path: '', key: 'config.err.unreadable', vars: { code: e.code }, message: `cannot read ${file} (${e.code})` });
    return res;
  }
  res.exists = true;
  let user;
  try {
    user = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (e) {
    res.errors.push({ file, path: '', key: 'config.err.parse', vars: { detail: e.message }, message: `${file}: invalid JSON (${e.message})` });
    return res;
  }
  const errors = validate(user, root).map((e) => ({ ...e, file }));
  res.errors = errors;
  if (!isObj(user)) return res;
  // Engine definitions (an executable to run) are only trusted from the global config: a cloned
  // repository must not be able to make `crew review run` start a program of its choosing.
  let ignoredEngines = null;
  if ('engines' in user) {
    ignoredEngines = isObj(user.engines) ? Object.keys(user.engines) : [];
    res.warnings.push({ file, path: 'engines', key: 'config.warn.engines', vars: { names: ignoredEngines.join(', ') }, message: require('./i18n').t('en', 'config.warn.engines', { names: ignoredEngines.join(', ') }) });
    user = { ...user };
    delete user.engines;
  }
  const merged = deepMerge(DEFAULTS, user);
  for (const e of errors) {
    const top = e.path.replace(/\[\d+\]$/, '');
    if (top) setPath(merged, top, getPath(DEFAULTS, top));
  }
  res.config = merged;
  return res;
}

// save(root, obj): validates obj, then merges it over the existing file so keys the schema does
// not know are preserved (keys cannot be deleted this way; set them to their default instead).
// A corrupt existing file is moved aside first. Throws CrewError config.invalid (err.errors) on bad input.
// opts.src is the event source ('cli' by default; the board passes 'board').
function save(root, obj, opts = {}) {
  const errors = validate(obj, root);
  if (isObj(obj) && 'engines' in obj) {
    errors.push({ path: 'engines', key: 'config.err.engines', vars: {}, message: require('./i18n').t('en', 'config.err.engines', { path: 'engines' }) });
  }
  if (errors.length) {
    const err = new CrewError('config.invalid', { count: errors.length, first: `${errors[0].path}: ${errors[0].message}` });
    err.errors = errors;
    throw err;
  }
  const file = configFile(root);
  const out = json.update(file, {}, (cur) => {
    const next = deepMerge(cur, obj);
    for (const k of Object.keys(cur)) delete cur[k];
    Object.assign(cur, next);
    return next;
  });
  try {
    const id = project.projectId(root);
    if (project.list().some((p) => p.id === id)) events.append(id, { type: 'config.changed', src: opts.src || 'cli', data: { file: '.claude/crew.json' }, key: `${Date.now()}:${Math.random()}` });
  } catch { /* the event is best effort */ }
  return out;
}

// ---------------------------------------------------------------- global config
function loadGlobal() {
  const file = paths.configFile();
  const r = json.readJson(file, {});
  const res = { config: clone(GLOBAL_DEFAULTS), errors: [], file, exists: r.status !== 'missing' };
  if (r.status === 'corrupt') {
    res.errors.push({ file, path: '', key: 'config.err.parse', vars: { detail: 'not a JSON object' }, message: `${file}: not a JSON object` });
    return res;
  }
  const errors = checkAgainst(r.data, GLOBAL_SCHEMA).map((e) => ({ ...e, file }));
  res.errors = errors;
  const merged = deepMerge(GLOBAL_DEFAULTS, r.data);
  for (const e of errors) {
    const top = e.path.replace(/\[\d+\]$/, '');
    if (top) setPath(merged, top, getPath(GLOBAL_DEFAULTS, top));
  }
  res.config = merged;
  return res;
}

function validateGlobal(obj) { return checkAgainst(obj, GLOBAL_SCHEMA); }

// Events live per project, so a global change is recorded (config.changed, scope "global") in
// the log of every registered project. opts.src as in save().
function saveGlobal(obj, opts = {}) {
  const errors = validateGlobal(obj);
  if (errors.length) {
    const err = new CrewError('config.invalid', { count: errors.length, first: `${errors[0].path}: ${errors[0].message}` });
    err.errors = errors;
    throw err;
  }
  const out = json.update(paths.configFile(), {}, (cur) => {
    const next = deepMerge(cur, obj);
    for (const k of Object.keys(cur)) delete cur[k];
    Object.assign(cur, next);
    return next;
  });
  try {
    const key = `${Date.now()}:${Math.random()}`;
    for (const p of project.list()) events.append(p.id, { type: 'config.changed', src: opts.src || 'cli', data: { file: 'config.json', scope: 'global' }, key });
  } catch { /* the event is best effort */ }
  return out;
}

module.exports = {
  DEFAULTS, GLOBAL_DEFAULTS, SCHEMA, GLOBAL_SCHEMA,
  globalEngines, validate, validateGlobal, load, save, loadGlobal, saveGlobal, configFile, deepMerge,
};
