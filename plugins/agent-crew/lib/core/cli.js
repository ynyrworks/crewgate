'use strict';

// CLI front end shared by bin/crew.js and the tests: global options, command discovery
// (lib/commands/<group>.js, loaded on demand) and the per-call context given to commands.
const fs = require('fs');
const path = require('path');
const { CrewError, UsageError } = require('./errors');
const { t, normalizeLang } = require('./i18n');
const project = require('./project');
const config = require('./config');

const COMMANDS_DIR = path.join(__dirname, '..', 'commands');
const GROUP_RE = /^[a-z][a-z0-9-]*$/;

// Removes --project/--json/--lang/--help (and -h) wherever they appear before "--".
function extractGlobals(argv) {
  const g = { project: undefined, json: false, lang: undefined, help: false, rest: [] };
  let stop = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (stop) { g.rest.push(a); continue; }
    if (a === '--') { stop = true; g.rest.push(a); continue; }
    if (a === '--json') { g.json = true; continue; }
    if (a === '--help' || a === '-h') { g.help = true; continue; }
    const m = /^--(project|lang)(?:=(.*))?$/.exec(a);
    if (m) {
      let v = m[2];
      if (v === undefined) {
        v = argv[i + 1];
        if (v === undefined || (v.startsWith('--') && v !== '--')) throw new UsageError('args.needsValue', { name: `--${m[1]}` });
        i++;
      }
      g[m[1]] = v;
      continue;
    }
    g.rest.push(a);
  }
  return g;
}

// Command groups available on disk: [{ name, mod }] sorted by name. Files starting with "_" are helpers.
function listGroups() {
  let names = [];
  try { names = fs.readdirSync(COMMANDS_DIR); } catch { return []; }
  const out = [];
  for (const n of names.sort()) {
    const m = /^([a-z][a-z0-9-]*)\.js$/.exec(n);
    if (!m) continue;
    try {
      const mod = require(path.join(COMMANDS_DIR, n));
      if (mod && typeof mod.run === 'function') out.push({ name: mod.name || m[1], mod });
    } catch { /* a broken command module must not break the others */ }
  }
  return out;
}

function loadGroup(name) {
  if (!GROUP_RE.test(name)) return null;
  const file = path.join(COMMANDS_DIR, `${name}.js`);
  if (!fs.existsSync(file)) return null;
  const mod = require(file);
  return mod && typeof mod.run === 'function' ? mod : null;
}

// Builds the context handed to command modules.
//   ctx.cwd, ctx.json, ctx.lang, ctx.langOption (the raw --lang value, for `init`)
//   ctx.t(key, vars)          translate in the active language
//   ctx.out(line) / ctx.err(line)
//   ctx.emit(data, lines)     --json prints data; otherwise prints lines (array or string)
//   ctx.project()             registered project { id, path, name, added } or null
//   ctx.requireProject()      same, but throws CrewError project.none
//   ctx.config()              project config (config.load) or defaults when no project
function createContext(g, io) {
  const cwd = process.cwd();
  let proj;
  let resolved = false;
  const ctx = {
    cwd,
    json: g.json,
    langOption: g.lang,
    lang: 'en',
    io,
    t: (key, vars) => t(ctx.lang, key, vars),
    out: (s) => io.stdout.write(`${s}\n`),
    err: (s) => io.stderr.write(`${s}\n`),
    emit(data, lines) {
      if (ctx.json) ctx.out(JSON.stringify(data, null, 2));
      else for (const l of [].concat(lines === undefined ? [] : lines)) ctx.out(l);
    },
    project() {
      if (!resolved) {
        proj = g.project !== undefined ? project.resolve(g.project) : project.findByCwd(cwd);
        resolved = true;
      }
      return proj;
    },
    requireProject() {
      const p = ctx.project();
      if (!p) throw new CrewError('project.none');
      return p;
    },
    config() {
      const p = ctx.project();
      return p ? config.load(p.path) : { config: config.load(cwd).config, errors: [] };
    },
  };
  // language: --lang, then the project's config, then the global config
  if (g.lang) {
    ctx.lang = normalizeLang(g.lang);
  } else {
    try {
      const p = ctx.project();
      const proj0 = p ? config.load(p.path) : null;
      if (proj0 && proj0.exists && proj0.config.language) ctx.lang = normalizeLang(proj0.config.language);
      else ctx.lang = normalizeLang(config.loadGlobal().config.language);
    } catch { /* stay on en */ }
  }
  return ctx;
}

function summaryOf(mod, lang) {
  const s = mod.summary || {};
  return s[lang] || s.en || '';
}

function printHelp(ctx) {
  ctx.out(ctx.t('cli.usage'));
  ctx.out('');
  const groups = listGroups();
  const w = Math.max(0, ...groups.map((x) => x.name.length));
  for (const x of groups) ctx.out(`  ${x.name.padEnd(w)}  ${summaryOf(x.mod, ctx.lang)}`);
  ctx.out('');
  ctx.out(ctx.t('cli.globals'));
}

function printGroupHelp(ctx, mod) {
  const u = mod.usage && (mod.usage[ctx.lang] || mod.usage.en);
  ctx.out(`${mod.name}: ${summaryOf(mod, ctx.lang)}`);
  if (u) ctx.out(u);
}

// main(argv, io?) -> exit code (0 ok, 1 runtime error, 2 usage error). Never throws.
async function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  let ctx;
  try {
    const g = extractGlobals(argv);
    ctx = createContext(g, io);
    const group = g.rest[0];
    if (!group) {
      printHelp(ctx);
      return g.help ? 0 : 2;
    }
    const mod = loadGroup(group);
    if (!mod) throw new UsageError('cli.unknownGroup', { group });
    if (g.help || g.rest.length === 1 && mod.requiresAction !== false) {
      printGroupHelp(ctx, mod);
      return g.help ? 0 : 2;
    }
    const code = await mod.run(g.rest.slice(1), ctx);
    return Number.isInteger(code) ? code : 0;
  } catch (e) {
    const lang = ctx ? ctx.lang : 'en';
    const prefix = t(lang, 'cli.errorPrefix');
    if (e instanceof CrewError) {
      io.stderr.write(`${prefix}${t(lang, e.key, e.vars)}\n`);
      if (e instanceof UsageError) io.stderr.write(`${t(lang, 'cli.tryHelp')}\n`);
      return e instanceof UsageError ? 2 : 1;
    }
    io.stderr.write(`${prefix}${e && e.message}\n`);
    if (process.env.AGENT_CREW_DEBUG && e && e.stack) io.stderr.write(`${e.stack}\n`);
    return 1;
  }
}

module.exports = { main, extractGlobals, listGroups, loadGroup, createContext };
