'use strict';

// Project config (<repo>/.claude/crew.json) and global config (~/.crewgate/config.json).
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
    enforce: 'remind', require_user_turn: true,
  },
  limits: {
    max_parallel_workers: 3,
    parallel_enforce: 'block',
    process_priority: 'below_normal',
    session_cpu_percent: 60,
    session_cleanup: 'on',
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
  plan: { max_proposals_per_round: 5, max_rounds: 3, large_growth: 5 },
  checks: [],
  forbidden: { paths: [], actions: [] },
  board: { enabled: true, port: 8781 },
  lessons: { promote_after_days: 3, rules_cap: 15, rules_file: 'CLAUDE.md' },
  release: { record_dir: '.crew/releases' },
});

const GLOBAL_DEFAULTS = Object.freeze({
  version: 1,
  language: 'en',
  port: 8781,
  usage_days: 14,
  prices: {},
  board: { show_text: false, session_idle_minutes: 30, session_done_hours: 6, detect_closed_transcripts: false, autostart: false },
  updates: { check: true },
  engines: {
    codex: { command: 'codex', args: ['exec', '-s', 'read-only', '--skip-git-repo-check', '-'] },
  },
});

const GATE = ['auto', 'ask', 'never'];
const GATE_DESC = {
  en: 'What to do before this action: auto (just do it), ask (ask the user in chat first) or never (forbidden; a detected push, PR or merge is denied before it runs, whatever gates.enforce says).',
  'zh-TW': '執行此動作前的處理方式：auto（直接做）、ask（先在對話中問使用者）、never（禁止；偵測到的推送、PR、合併會在執行前被拒絕，與 gates.enforce 無關）。',
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
  f('gates.enforce', 'string', d(
    'When a push, PR or merge under an "ask" gate is checked: remind (after the command, reminder only), confirm (before it, Claude Code asks you to allow it) or block (before it, the command is denied until an approval is recorded). Best effort: detection reads the command text, so a script that pushes is not seen.',
    '「ask」關卡的推送、PR、合併何時檢查：remind（執行後提醒）、confirm（執行前由 Claude Code 詢問你是否允許）、block（執行前拒絕，直到記錄核准）。這是盡力攔截：偵測只讀指令文字，看不到腳本裡的推送。'), { enum: ['remind', 'confirm', 'block'] }),
  f('gates.require_user_turn', 'boolean', d(
    'An approval counts only when you sent a message between "gate ask" and "gate answer yes", so the model cannot approve itself within one turn.',
    '核准要在「gate ask」與「gate answer yes」之間有使用者送出訊息才算數，避免模型在同一輪自己核准。')),
  f('limits', 'object', d('Limits and guards.', '限制與守門。')),
  f('limits.max_parallel_workers', 'integer', d('Most workers running at once.', '同時進行的 worker 上限。'), { min: 1, max: 20 }),
  f('limits.parallel_enforce', 'string', d(
    'What happens when a dispatch (or a SendMessage that wakes a stopped worker) would pass max_parallel_workers: block (denied; the reason names the running tasks) or warn (a reminder only). Workers are counted from the dispatch map, so records left by an ended or quit session do not count.',
    '派出（或用 SendMessage 喚醒已停止的 worker）會超過 max_parallel_workers 時的處理：block（拒絕，理由會列出進行中的任務）或 warn（只提醒）。worker 數依派工紀錄計算，已結束或被關閉的工作階段留下的紀錄不算。'), { enum: ['block', 'warn'] }),
  f('limits.process_priority', 'string', d(
    'Priority of the Claude Code process, set at session start in a registered crew project: below_normal (it and everything it starts, such as shells and test runs, yield CPU to your other apps) or normal (leave it alone). It is only ever lowered, and only when the parent process is identified as Claude Code.',
    '工作階段開始時（限已註冊的 crew 專案）Claude Code 行程的優先權：below_normal（它與它啟動的 shell、測試等都會把 CPU 讓給你的其他應用程式）或 normal（不動）。只會降低，且只在確認上層行程是 Claude Code 時才動。'), { enum: ['below_normal', 'normal'] }),
  f('limits.session_cpu_percent', 'integer', d(
    'Windows only, in a registered crew project: the most CPU the Claude Code process and everything it starts after session start may use together, as a percentage of the whole machine (a Job Object hard cap). 100 means no cap. Children that started before the job was set up are not covered.',
    '僅 Windows、限已註冊的 crew 專案：Claude Code 行程與其之後啟動的所有行程合計最多可用的 CPU，以整台機器的百分比計（Job Object 硬上限）。100 代表不設上限。在建立 job 之前就已啟動的子行程不受限。'), { min: 10, max: 100 }),
  f('limits.session_cleanup', 'string', d(
    'Windows only: when the Claude Code process exits, on stops the background processes left in its job and records how many; off only lists and records them. Never stopped: the running board and what it started, and any program with a visible window (such as a browser) with its child processes. A program opened from a session keeps the below-normal priority and the CPU cap until you close it. If board.json cannot be read, nothing is stopped. A console process whose visible window belongs to another process (a Windows Terminal tab opened from a session) can count as background and be stopped; set off to avoid that.',
    '僅 Windows：Claude Code 行程結束時，on 會停止留在它 job 裡的背景行程並記錄數量；off 只列出並記錄，不停止。不會停止的：執行中的看板與它啟動的行程，以及有可見視窗的程式（例如瀏覽器）與其子行程。從工作階段開啟的程式在你關閉它之前，仍保持較低優先權與 CPU 上限。board.json 讀不了時一律不停止。視窗屬於其他行程的主控台行程（例如從工作階段開啟的 Windows Terminal 分頁）可能被當作背景行程而停止；要避免請設為 off。'), { enum: ['on', 'off'] }),
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
  f('plan', 'object', d('Plan review limits.', '計畫審查的上限。')),
  f('plan.max_proposals_per_round', 'integer', d('Most proposed steps one plan review round may add (the most severe kinds are kept, the rest are counted as cut).', '一輪計畫審查最多提出幾個提議節點（保留最嚴重的類型，其餘記為截掉）。'), { min: 1, max: 50 }),
  f('plan.max_rounds', 'integer', d('Plan review rounds allowed per plan (--force on "plan review run" overrides).', '每份計畫最多可做幾輪計畫審查（「plan review run」加 --force 可超過）。'), { min: 1, max: 20 }),
  f('plan.large_growth', 'integer', d('When more than this many proposals have been accepted in one plan since the last large_task approval, the CLI prints the large_task gate hint and records a need (it does not block).', '同一份計畫自上次 large_task 核准後，接受的提議超過此數量時，CLI 會印出 large_task 關卡提示並記一筆待決事項（不阻擋）。'), { min: 1, max: 100 }),
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
  f('release', 'object', d('Release records.', '版本紀錄。')),
  f('release.record_dir', 'string', d('Folder (relative to the project root) where `crew release record` writes <version>.md. The files are meant to be committed; `--dir` overrides it for one run.', '`crew release record` 寫入 <版本>.md 的資料夾（相對於專案根目錄）。這些檔案預期要提交進版本庫；單次可用 `--dir` 覆蓋。')),
  f('account', 'object', d('Claude account this project expects.', '此專案預期使用的 Claude 帳號。')),
  f('account.expected', 'string', d('Claude account this project should run under: an email address, organization name or account UUID, matched case-insensitively. When a session starts under another account (or the account cannot be determined), the session brief carries one warning line, an account.mismatch event is recorded and one need is added. It never blocks. Empty (default) turns the check off.', '此專案應使用的 Claude 帳號：電子郵件、組織名稱或帳號 UUID，不分大小寫比對。工作階段以其他帳號開始（或無法判斷帳號）時，簡報會多一行警告、記錄 account.mismatch 事件並新增一筆待決事項，不會阻擋。留空（預設）表示不檢查。')),
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
  f('board.show_text', 'boolean', d('Show short redacted snippets (last prompt, last reply, session title) and the target of the current tool call (file, command, pattern) in the Sessions list.', '在工作階段清單顯示簡短的已遮罩片段（最後提示、最後回覆、工作階段標題）與目前工具呼叫的目標（檔案、指令、模式）。')),
  f('board.session_idle_minutes', 'integer', d('Minutes without activity after which a Sessions entry shows as idle.', '工作階段超過這段分鐘數沒有動靜就顯示為閒置。'), { min: 1, max: 1440 }),
  f('board.session_done_hours', 'integer', d('Hours without activity after which a Sessions entry shows as done.', '工作階段超過這段小時數沒有動靜就顯示為已結束。'), { min: 1, max: 720 }),
  f('board.detect_closed_transcripts', 'boolean', d('Treat a transcript that ends in a closing record (last-prompt) as a finished session. Off by default: the record is not verified to mean the session ended, so a live session waiting for you could be shown as done.', '把結尾為關閉記錄（last-prompt）的逐字稿視為已結束的工作階段。預設關閉：該記錄是否代表工作階段結束尚未驗證，開啟後等待您回應的使用中工作階段可能被顯示為已結束。')),
  f('board.autostart', 'boolean', d('Start the board when a Claude Code or Codex session starts and it is not running (the SessionStart hook spawns it detached and does not wait; a project with board.enabled false is skipped; the exact port is used, no search). Off by default: crewgate does not start a server you did not ask for.', '工作階段開始時若看板沒有在執行就自動啟動（SessionStart hook 以分離程序啟動、不等待；專案設定 board.enabled 為 false 時略過；只用指定的連接埠，不往上找）。預設關閉：crewgate 不會自行啟動你沒要求的伺服器。')),
  f('updates', 'object', d('Update notices.', '更新通知。')),
  f('updates.check', 'boolean', d('Let the board ask GitHub (api.github.com, at most once a day, nothing about you or your projects is sent) whether a newer crewgate release exists and show a notice. Turn off to make no network request at all.', '讓看板向 GitHub（api.github.com，一天最多一次，不會送出任何關於您或專案的資料）查詢是否有較新的 crewgate 版本並顯示通知。關閉後完全不發出網路請求。')),
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
// account.expected is documented as empty by default but kept out of DEFAULTS: an empty string is not a valid value to write
// (the crew.json template equals DEFAULTS), and a missing key already means "no check".
SCHEMA.find((e) => e.path === 'account.expected').default = '';
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

// Directory whose .claude/crew.json applies: the work tree when it has its own file (a branch may change
// the config), else the project root. Both may be the same directory.
function configDir(workTree, root) {
  if (workTree && root && workTree !== root && fs.existsSync(configFile(workTree))) return workTree;
  return workTree && !root ? workTree : root;
}

function configFile(root) { return paths.projectConfigFile(root); }

// loadFor(workTree, root) = load(configDir(workTree, root)).
function loadFor(workTree, root) { return load(configDir(workTree, root)); }

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
  globalEngines, validate, validateGlobal, load, loadFor, configDir, save, loadGlobal, saveGlobal, configFile, deepMerge,
};
