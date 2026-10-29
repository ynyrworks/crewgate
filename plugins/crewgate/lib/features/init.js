'use strict';

// `crew init`: write the project config, render the agent copies and the .crew files, register the project.
const fs = require('fs');
const path = require('path');
const json = require('../core/json');
const config = require('../core/config');
const project = require('../core/project');
const { normalizeLang } = require('../core/i18n');
const common = require('./common');
const { detectChecks } = require('./stack');

const TEMPLATES = path.join(common.PLUGIN_ROOT, 'templates');
const AGENTS = ['crew-worker', 'crew-reviewer', 'crew-refuter'];
const ROLE_OF = { 'crew-worker': 'worker', 'crew-reviewer': 'reviewer', 'crew-refuter': 'refuter' };

const LANGUAGE_NAME = { en: 'English', 'zh-TW': 'Traditional Chinese (繁體中文)' };
const HEADINGS = {
  en: ['Branch & commits', 'What changed and why', 'Tests run', 'Assumptions & unfinished', 'Needs real-environment check'],
  'zh-TW': ['分支與提交', '改了什麼與原因', '測試', '假設與未完成', '需要實機確認'],
};

function template(rel) { return fs.readFileSync(path.join(TEMPLATES, rel), 'utf8'); }

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

// {{name}} placeholders; unknown ones stay visible so a typo is easy to spot.
function fill(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

function forbiddenBlock(cfg) {
  const lines = [];
  for (const p of cfg.forbidden.paths) lines.push(`- Never touch this path: \`${oneLine(p).replace(/`/g, "'")}\``);
  for (const a of cfg.forbidden.actions) lines.push(`- Never: ${oneLine(a)}`);
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function checksBlock(cfg) {
  if (!cfg.checks.length) return "- No project checks are configured: run the project's own test suite.";
  return cfg.checks.map((c) => `- \`${oneLine(c).replace(/`/g, "'")}\``).join('\n');
}

// -> text of one rendered agent file for the given config.
function renderAgent(name, cfg) {
  const role = cfg.roles[ROLE_OF[name]] || {};
  const lang = normalizeLang(cfg.language);
  return fill(template(path.join('agents', `${name}.md`)), {
    model: role.model || 'sonnet',
    forbidden_block: forbiddenBlock(cfg),
    checks_block: checksBlock(cfg),
    language_name: LANGUAGE_NAME[lang],
    report_max_tokens: cfg.limits.report_max_tokens,
    report_headings: HEADINGS[lang].map((h) => `## ${h}`).join('\n'),
    categories: cfg.review.categories.join(', '),
    min_confidence: cfg.review.min_confidence,
  });
}

const slash = (p) => p.split(path.sep).join('/');

function stampName() { return new Date().toISOString().replace(/[-:.]/g, '').replace('Z', ''); }

// Writes `text` to file unless it exists (then: kept, or backed up + overwritten with force).
function put(root, rel, text, force, out) {
  const file = path.join(root, rel);
  const exists = fs.existsSync(file);
  if (exists && !force) { out.push({ file: rel, action: 'kept' }); return; }
  let backup;
  if (exists) {
    backup = `${rel}.bak-${stampName()}`;
    fs.copyFileSync(file, path.join(root, backup));
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  json.saveRaw(file, text);
  out.push({ file: rel, action: exists ? 'overwritten' : 'created', ...(backup ? { backup } : {}) });
}

// When the config has no checks yet, proposes the stack's usual test commands and writes them into the
// file. Existing checks are never touched. -> { detected: [...], written: boolean, kept?: number }
function fillChecks(root, cfgRel, files) {
  const detected = detectChecks(root);
  const file = path.join(root, cfgRel);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { detected, written: false }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { detected, written: false };
  if (Array.isArray(raw.checks) && raw.checks.length) return { detected: [], written: false, kept: raw.checks.length };
  if (!detected.length) return { detected, written: false };
  raw.checks = detected;
  json.saveRaw(file, `${JSON.stringify(raw, null, 2)}\n`);
  const row = files.find((f) => f.file === cfgRel);
  if (row && row.action === 'kept') row.action = 'updated';
  return { detected, written: true };
}

// init(root, { lang, force, resetReviewFiles, fallbackLang }) -> { root, project, created, files: [{ file, action, backup? }], language }
function init(root, opts = {}) {
  const force = !!opts.force;
  const files = [];
  const existing = config.load(root);
  const language = normalizeLang(opts.lang || (existing.exists && existing.config.language) || opts.fallbackLang);
  const cfgRel = path.join('.claude', 'crew.json');
  let base = JSON.parse(template('crew.json'));
  if (force && existing.exists) {
    // --force refreshes the file but keeps the user's values (the old copy is backed up)
    try {
      const old = JSON.parse(fs.readFileSync(path.join(root, cfgRel), 'utf8'));
      if (old && typeof old === 'object' && !Array.isArray(old)) base = config.deepMerge(base, old);
    } catch { /* unreadable: start from the defaults */ }
  }
  base.language = language;
  put(root, cfgRel, `${JSON.stringify(base, null, 2)}\n`, force, files);
  const checks = fillChecks(root, cfgRel, files);
  const cfg = config.load(root).config;
  for (const name of AGENTS) put(root, path.join('.claude', 'agents', `${name}.md`), renderAgent(name, cfg), force, files);
  // REVIEW.md and LESSONS.md hold the user's own rules and notes: --force leaves them alone,
  // only --reset-review-files replaces them (the old copy is backed up first)
  const reset = !!opts.resetReviewFiles;
  put(root, path.join('.crew', 'REVIEW.md'), template('REVIEW.md'), reset, files);
  put(root, path.join('.crew', 'LESSONS.md'), template('LESSONS.md'), reset, files);
  // the dismissed ledger holds user decisions: never replaced, not even with --force
  const ledger = path.join('.crew', 'dismissed.jsonl');
  if (fs.existsSync(path.join(root, ledger))) files.push({ file: ledger, action: 'kept' });
  else put(root, ledger, '', false, files);
  const { project: p, created } = project.add(root);
  return { root, project: p, created, language, checks, files: files.map((f) => ({ ...f, file: slash(f.file), ...(f.backup ? { backup: slash(f.backup) } : {}) })) };
}

module.exports = { AGENTS, renderAgent, init, fill, HEADINGS, LANGUAGE_NAME };
