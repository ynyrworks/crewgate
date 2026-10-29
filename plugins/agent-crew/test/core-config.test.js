'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

h.setupHome();
const config = require('../lib/core/config');
const project = require('../lib/core/project');
const events = require('../lib/core/events');
const paths = require('../lib/core/paths');

function repoWith(content) {
  const root = h.tmpDir('crew-cfg-');
  if (content !== undefined) {
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.claude', 'crew.json'), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

test('defaults match the design and validate cleanly', () => {
  assert.deepEqual(config.validate(config.DEFAULTS), []);
  assert.equal(config.DEFAULTS.limits.report_max_tokens, 1500);
  assert.equal(config.DEFAULTS.board.port, 8781);
  assert.equal(config.DEFAULTS.roles.worker.agent, 'crew-worker');
  assert.deepEqual(config.validate({}), []);
});

test('load: no file gives defaults; partial file is merged over defaults', () => {
  const none = config.load(repoWith());
  assert.equal(none.exists, false);
  assert.deepEqual(none.errors, []);
  assert.deepEqual(none.config, JSON.parse(JSON.stringify(config.DEFAULTS)));
  const r = config.load(repoWith({ limits: { max_parallel_workers: 5 }, roles: { docs: { engine: 'claude', model: 'haiku' } }, custom: { keep: 1 } }));
  assert.equal(r.config.limits.max_parallel_workers, 5);
  assert.equal(r.config.limits.report_max_tokens, 1500);
  assert.equal(r.config.roles.worker.model, 'sonnet');
  assert.equal(r.config.roles.docs.model, 'haiku');
  assert.equal(r.config.custom.keep, 1);
  assert.deepEqual(r.errors, []);
});

test('load never mutates DEFAULTS and arrays are replaced, not merged', () => {
  const r = config.load(repoWith({ checks: ['npm test'], limits: { orchestrator_edit_allow: ['x/**'] } }));
  assert.deepEqual(r.config.checks, ['npm test']);
  assert.deepEqual(r.config.limits.orchestrator_edit_allow, ['x/**']);
  assert.deepEqual(config.DEFAULTS.checks, []);
  assert.equal(config.DEFAULTS.limits.orchestrator_edit_allow.length, 4);
});

test('load: invalid fields are reported with file and path, and fall back to defaults', () => {
  const root = repoWith({
    limits: { max_parallel_workers: 'many', report_max_tokens: 5, orchestrator_edit: 'sometimes' },
    gates: { push: 'maybe' }, board: { port: 80 }, checks: ['ok', 3], roles: { x: { engine: 'ghost' } },
  });
  const r = config.load(root);
  const byPath = Object.fromEntries(r.errors.map((e) => [e.path, e]));
  for (const p of ['limits.max_parallel_workers', 'limits.report_max_tokens', 'limits.orchestrator_edit', 'gates.push', 'board.port', 'checks[1]', 'roles.x.engine']) {
    assert.ok(byPath[p], `missing error for ${p}`);
    assert.equal(byPath[p].file, path.join(root, '.claude', 'crew.json'));
  }
  assert.equal(r.config.limits.max_parallel_workers, 3);
  assert.equal(r.config.limits.report_max_tokens, 1500);
  assert.equal(r.config.limits.orchestrator_edit, 'warn');
  assert.equal(r.config.gates.push, 'ask');
  assert.equal(r.config.board.port, 8781);
  assert.deepEqual(r.config.checks, []);
  assert.equal(r.config.roles.x.engine, undefined);
});

test('load: broken JSON, non-object and unreadable path never throw', () => {
  const bad = config.load(repoWith('{nope'));
  assert.equal(bad.exists, true);
  assert.equal(bad.errors[0].key, 'config.err.parse');
  assert.equal(bad.config.limits.max_parallel_workers, 3);
  const arr = config.load(repoWith('[1]'));
  assert.equal(arr.errors[0].key, 'config.err.notObject');
  const dirAsFile = repoWith();
  fs.mkdirSync(path.join(dirAsFile, '.claude', 'crew.json'), { recursive: true });
  const r = config.load(dirAsFile);
  assert.equal(r.errors[0].key, 'config.err.unreadable');
  assert.equal(r.config.board.enabled, true);
});

test('validate: engine may name a key of engines, claude, or the built-in codex', () => {
  assert.deepEqual(config.validate({ roles: { r: { engine: 'codex' } } }), []);
  // an engine defined only in the project is not known: definitions come from the global config
  assert.equal(config.validate({ roles: { r: { engine: 'mine' } }, engines: { mine: { command: 'x', args: [] } } }).length, 1);
  assert.equal(config.validate({ roles: { r: { engine: 'mine' } } }).length, 1);
  config.saveGlobal({ engines: { mine: { command: 'x', args: [] } } });
  assert.deepEqual(config.validate({ roles: { r: { engine: 'mine' } } }), []);
  fs.rmSync(paths.configFile(), { force: true });
  assert.equal(config.validate({ version: 2 }).length, 1);
  assert.equal(config.validate({ review: { min_confidence: 1.5 } })[0].key, 'config.err.max');
  assert.equal(config.validate('str')[0].key, 'config.err.notObject');
});

test('save validates, preserves unknown keys and registered projects get a config.changed event', () => {
  const root = repoWith({ custom: { a: 1 }, limits: { max_parallel_workers: 2 } });
  const reg = project.add(root).project;
  config.save(root, { limits: { report_max_tokens: 900 }, board: { port: 9000 } });
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'crew.json'), 'utf8'));
  assert.deepEqual(onDisk.custom, { a: 1 });
  assert.equal(onDisk.limits.max_parallel_workers, 2);
  assert.equal(onDisk.limits.report_max_tokens, 900);
  assert.equal(onDisk.board.port, 9000);
  assert.equal(events.read(reg.id, { types: 'config.changed' }).length, 1);
  assert.equal(config.load(root).config.limits.report_max_tokens, 900);
  assert.throws(() => config.save(root, { board: { port: 1 } }), (e) => e.key === 'config.invalid' && e.errors[0].path === 'board.port');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.claude', 'crew.json'), 'utf8')).board.port, 9000);
});

test('save creates the file in a repo that has none and moves a corrupt one aside', () => {
  const root = repoWith();
  config.save(root, { language: 'zh-TW' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.claude', 'crew.json'), 'utf8')).language, 'zh-TW');
  const broken = repoWith('{{');
  config.save(broken, { language: 'en' });
  assert.ok(fs.readdirSync(path.join(broken, '.claude')).some((n) => n.startsWith('crew.json.corrupt-')));
});

test('schema description is complete for a settings form', () => {
  const paths_ = new Set(config.SCHEMA.map((e) => e.path));
  for (const p of ['language', 'roles.*.engine', 'gates.push', 'limits.report_max_tokens', 'review.min_confidence', 'board.port', 'lessons.rules_cap']) {
    assert.ok(paths_.has(p), p);
  }
  for (const e of config.SCHEMA) {
    assert.ok(e.type && e.path, JSON.stringify(e));
    assert.ok(e.description.en && e.description['zh-TW'], e.path);
  }
  const port = config.SCHEMA.find((e) => e.path === 'board.port');
  assert.deepEqual([port.type, port.min, port.max, port.default], ['integer', 1024, 65535, 8781]);
  const gate = config.SCHEMA.find((e) => e.path === 'gates.merge');
  assert.deepEqual(gate.enum, ['auto', 'ask', 'never']);
});

test('global config: defaults, validation, merge and save', () => {
  const g = config.loadGlobal();
  assert.equal(g.exists, false);
  assert.equal(g.config.port, 8781);
  config.saveGlobal({ port: 9100, prices: { sonnet: { input: 3, output: 15 } } });
  const g2 = config.loadGlobal();
  assert.equal(g2.config.port, 9100);
  assert.equal(g2.config.prices.sonnet.output, 15);
  assert.deepEqual(g2.errors, []);
  assert.throws(() => config.saveGlobal({ port: 'x' }), (e) => e.key === 'config.invalid');
  fs.writeFileSync(paths.configFile(), '{"port": 5}');
  const bad = config.loadGlobal();
  assert.equal(bad.errors[0].path, 'port');
  assert.equal(bad.config.port, 8781);
  fs.writeFileSync(paths.configFile(), 'garbage');
  assert.equal(config.loadGlobal().errors[0].key, 'config.err.parse');
});

test('save and saveGlobal accept an event source; global saves record config.changed', () => {
  const root = repoWith({});
  const reg = project.add(root).project;
  config.save(root, { limits: { report_max_tokens: 800 } }, { src: 'board' });
  config.saveGlobal({ port: 9200 }, { src: 'board' });
  config.saveGlobal({ port: 9201 });
  const ev = events.read(reg.id, { types: 'config.changed' });
  assert.deepEqual(ev.map((e) => e.src), ['board', 'board', 'cli']);
  assert.equal(ev[1].data.scope, 'global');
  config.saveGlobal({ port: 8781 });
});

test('global schema has board.show_text and cache prices', () => {
  const paths_ = config.GLOBAL_SCHEMA.map((e) => e.path);
  for (const p of ['board.show_text', 'prices.*.cache_write', 'prices.*.cache_read']) assert.ok(paths_.includes(p), p);
  assert.equal(config.GLOBAL_SCHEMA.find((e) => e.path === 'board.show_text').default, false);
  assert.deepEqual(config.validateGlobal({ board: { show_text: true }, prices: { m: { cache_read: 0.3, cache_write: 3.75 } } }), []);
  assert.equal(config.validateGlobal({ prices: { m: { cache_read: -1 } } })[0].path, 'prices.m.cache_read');
  assert.equal(config.validateGlobal({ board: { show_text: 'yes' } })[0].path, 'board.show_text');
});
