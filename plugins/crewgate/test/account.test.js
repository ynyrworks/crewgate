'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./hooks-helpers');
const bh = require('./board-helpers');
const u = require('./workflow-util');
const account = require('../lib/core/account');
const store = require('../lib/core/store');
const paths = require('../lib/core/paths');
const SM = require('../board/public/sessions-model.js');

const UUID = '1a2b3c4d-1111-4222-8333-444455556666';
const OTHER = '9f8e7d6c-1111-4222-8333-444455556666';
const ORG = 'aaaa1111-2222-4333-8444-555566667777';
const EMAIL = 'ann@example.com';
const BLANK = { CLAUDE_CODE_ACCOUNT_UUID: '', CLAUDE_CODE_ORGANIZATION_UUID: '', ANTHROPIC_API_KEY: '' };

// A config dir holding .claude.json with a fake oauthAccount (or any raw text).
function cfgDir(oauth, raw) {
  const dir = bh.tmpDir('crew-acct-cfg-');
  const body = raw !== undefined ? raw : JSON.stringify({ oauthAccount: oauth });
  fs.writeFileSync(path.join(dir, '.claude.json'), body);
  return dir;
}
const FILE_ACCT = { accountUuid: UUID, emailAddress: EMAIL, organizationName: 'Example Org', organizationUuid: ORG, billingType: 'stripe_subscription', seatTier: 'tier1' };
const envOf = (dir, extra = {}) => ({ CLAUDE_CONFIG_DIR: dir, ...BLANK, ...extra });
const hookEnv = (dir, extra) => ({ ...envOf(dir, extra), CREWGATE_HOME: process.env.CREWGATE_HOME });

test('source: the file alone gives id, plan (billingType first) and a label', () => {
  const a = account.current(envOf(cfgDir(FILE_ACCT)));
  assert.equal(a.id, '1a2b3c4d');
  assert.equal(a.plan, 'stripe_subscription');
  assert.deepEqual(a.label, { email: EMAIL, organization: 'Example Org' });
  const seat = account.current(envOf(cfgDir({ accountUuid: UUID, seatTier: 'tier1' })));
  assert.equal(seat.plan, 'tier1');
  assert.equal(seat.label, null);
});

test('source: the environment UUID wins; the same account keeps the file label', () => {
  const same = account.current(envOf(cfgDir(FILE_ACCT), { CLAUDE_CODE_ACCOUNT_UUID: UUID.toUpperCase(), CLAUDE_CODE_ORGANIZATION_UUID: ORG }));
  assert.equal(same.id, '1a2b3c4d');
  assert.equal(same.label.email, EMAIL);
  const onlyEnv = account.current(envOf(cfgDir(undefined, 'not json'), { CLAUDE_CODE_ACCOUNT_UUID: UUID }));
  assert.equal(onlyEnv.id, '1a2b3c4d');
  assert.equal(onlyEnv.label, null);
});

test('source: a UUID from the environment that differs from the file gives the UUID only, no label and no plan', () => {
  const a = account.current(envOf(cfgDir(FILE_ACCT), { CLAUDE_CODE_ACCOUNT_UUID: OTHER }));
  assert.equal(a.id, '9f8e7d6c');
  assert.equal(a.label, null);
  assert.equal(a.plan, '');
  const org = account.current(envOf(cfgDir(FILE_ACCT), { CLAUDE_CODE_ACCOUNT_UUID: UUID, CLAUDE_CODE_ORGANIZATION_UUID: 'bbbb1111-2222-4333-8444-555566667777' }));
  assert.equal(org.label, null, 'another organization: the file describes another account');
});

test('source: malformed, missing, wrong-shape files and an API key give no account and never throw', () => {
  for (const raw of ['{broken', '[]', '{"oauthAccount": 5}', '{"oauthAccount": {"emailAddress": "x@example.com"}}', '']) {
    assert.equal(account.current(envOf(cfgDir(undefined, raw))), null, raw);
  }
  assert.equal(account.current(envOf(bh.tmpDir('crew-acct-empty-'))), null, 'missing file');
  assert.equal(account.current(envOf(cfgDir(FILE_ACCT), { ANTHROPIC_API_KEY: 'sk-fake' })), null, 'API key user');
});

test('matches: email, organization, UUID and short id, case-insensitive; unknown account gives null', () => {
  const a = account.current(envOf(cfgDir(FILE_ACCT)));
  for (const w of [EMAIL, 'ANN@Example.COM', 'example org', UUID, '1A2B3C4D', ORG]) assert.equal(account.matches(a, w), true, w);
  assert.equal(account.matches(a, 'bob@example.com'), false);
  assert.equal(account.matches(a, ''), true);
  assert.equal(account.matches(null, 'ann@example.com'), null);
  const uuidOnly = account.current(envOf(cfgDir(FILE_ACCT), { CLAUDE_CODE_ACCOUNT_UUID: OTHER }));
  assert.equal(account.matches(uuidOnly, EMAIL), false, 'the label is unknown but the id is: it is not this email');
});

const ctxOf = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
const startWith = (f, env, extra = {}) => h.runHook('session-start', h.base(f, { source: 'startup', ...extra }), { cwd: f.repo, env });
const allEvents = (f) => fs.readFileSync(paths.eventsFile(f.pid), 'utf8');

test('SessionStart records account_id and plan, never the email; the label goes to accounts.json only', () => {
  const f = h.fixture();
  const r = startWith(f, hookEnv(cfgDir(FILE_ACCT)));
  assert.equal(r.code, 0);
  const [ev] = h.evs(f, 'session.start');
  assert.equal(ev.data.account_id, '1a2b3c4d');
  assert.equal(ev.data.plan, 'stripe_subscription');
  assert.ok(!/example\.com|Example Org/.test(allEvents(f)), 'no label in the events file');
  assert.ok(!/example\.com|Example Org/.test(ctxOf(r)), 'no label in the brief');
  assert.equal(h.evs(f, 'account.mismatch').length, 0);
  assert.deepEqual(account.label('1a2b3c4d'), { email: EMAIL, organization: 'Example Org' });
  assert.ok(fs.existsSync(path.join(process.env.CREWGATE_HOME, 'accounts.json')));
});

test('SessionStart with environment UUIDs only: id recorded, no label written', () => {
  const f = h.fixture();
  startWith(f, hookEnv(bh.tmpDir('crew-acct-none-'), { CLAUDE_CODE_ACCOUNT_UUID: OTHER }));
  assert.equal(h.evs(f, 'session.start')[0].data.account_id, '9f8e7d6c');
  assert.equal(account.label('9f8e7d6c'), null);
});

test('SessionStart with no account (API key, malformed file, Codex): nothing recorded, no warning without account.expected', () => {
  const f = h.fixture();
  const r1 = startWith(f, hookEnv(cfgDir(undefined, '{broken')));
  assert.equal(r1.code, 0);
  assert.ok(ctxOf(r1).includes('<crew-state'));
  const r2 = startWith(f, hookEnv(cfgDir(FILE_ACCT), { ANTHROPIC_API_KEY: 'sk-fake' }), { session_id: 'sess-2' });
  const r3 = startWith(f, hookEnv(cfgDir(FILE_ACCT)), { session_id: 'sess-3', turn_id: 't1' });
  for (const r of [r1, r2, r3]) assert.doesNotMatch(ctxOf(r), /WARNING/);
  for (const ev of h.evs(f, 'session.start')) assert.ok(!('account_id' in ev.data));
  assert.equal(h.evs(f, 'account.mismatch').length, 0);
  assert.equal(store.needList(f.pid).length, 0);
});

test('account.expected match: no warning, no event, no need', () => {
  const f = h.fixture({ config: { version: 1, account: { expected: 'ANN@example.com' } } });
  const r = startWith(f, hookEnv(cfgDir(FILE_ACCT)));
  assert.doesNotMatch(ctxOf(r), /WARNING/);
  assert.equal(h.evs(f, 'account.mismatch').length, 0);
  assert.equal(store.needList(f.pid).length, 0);
});

test('account.expected mismatch: one brief line, one event, one need per session; never blocks; brief within the cap', () => {
  const f = h.fixture({ config: { version: 1, account: { expected: 'bob@example.com' } } });
  const r = startWith(f, hookEnv(cfgDir(FILE_ACCT)));
  assert.equal(r.code, 0);
  const text = ctxOf(r);
  assert.match(text, /WARNING: this session runs under a Claude account other than/);
  assert.ok(Buffer.byteLength(text) <= 4000);
  assert.ok(!text.includes('bob@example.com') && !text.includes(EMAIL));
  const evs = h.evs(f, 'account.mismatch');
  assert.equal(evs.length, 1);
  assert.deepEqual(evs[0].data, { reason: 'mismatch', account_id: '1a2b3c4d' });
  assert.equal(store.needList(f.pid).length, 1);
  // the same session starts again (resume, compaction): the line stays, the need and event do not repeat
  const again = startWith(f, hookEnv(cfgDir(FILE_ACCT)), { source: 'resume' });
  assert.match(ctxOf(again), /WARNING/);
  assert.equal(store.needList(f.pid).length, 1);
  assert.equal(h.evs(f, 'account.mismatch').length, 1);
  assert.ok(!/bob@example\.com|ann@example\.com/.test(allEvents(f)), 'no email in any event');
});

test('account.expected set but the account cannot be determined: a warning that says so, still not blocking', () => {
  const f = h.fixture({ config: { version: 1, account: { expected: 'bob@example.com' } } });
  const r = startWith(f, hookEnv(bh.tmpDir('crew-acct-none-')));
  assert.equal(r.code, 0);
  assert.match(ctxOf(r), /could not be determined/);
  const [ev] = h.evs(f, 'account.mismatch');
  assert.equal(ev.data.reason, 'unknown');
  assert.equal(store.needList(f.pid).length, 1);
  const zh = h.fixture({ config: { version: 1, language: 'zh-TW', account: { expected: 'bob@example.com' } } });
  assert.match(ctxOf(startWith(zh, hookEnv(bh.tmpDir('crew-acct-none-')))), /無法判斷/);
});

test('doctor shows the current and the expected account', () => {
  const repo = u.initRepo();
  const env = envOf(cfgDir(FILE_ACCT));
  const run = (extra = []) => JSON.parse(bh.crew(['--json', ...extra, 'doctor'], repo, env).out).checks.find((c) => c.name === 'account');
  const none = run();
  assert.equal(none.status, 'ok');
  assert.ok(none.detail.includes(EMAIL) && none.detail.includes('no expected account'));
  u.patchCfg(repo, (c) => { c.account = { expected: 'bob@example.com' }; });
  const bad = run();
  assert.equal(bad.status, 'warn');
  assert.ok(bad.detail.includes('expected bob@example.com') && bad.detail.includes('not the expected account'));
  u.patchCfg(repo, (c) => { c.account = { expected: 'ann@example.com' }; });
  assert.equal(run().status, 'ok');
  assert.match(run(['--lang', 'zh-TW']).detail, /預期 ann@example\.com/);
});

test('config: account.expected is in the schema with a default', () => {
  const config = require('../lib/core/config');
  const e = config.SCHEMA.find((x) => x.path === 'account.expected');
  assert.equal(e.type, 'string');
  assert.equal(e.default, '');
  assert.ok(config.validate({ account: { expected: 5 } }).length > 0);
  assert.deepEqual(config.validate({ account: { expected: 'a@example.com' } }), []);
});

// ---- the board
const { createBoard } = require('../board/server');
const projects = require('../lib/core/project');
const events = require('../lib/core/events');

test('board API: sessions carry the account (label from accounts.json); a session with no record shows nothing', async () => {
  const claudeRoot = bh.tmpDir('crew-acct-claude-');
  const repo = bh.makeRepo();
  const proj = projects.add(repo, { name: 'demo' }).project;
  const mk = (sid) => {
    const base = { cwd: repo, timestamp: new Date().toISOString(), sessionId: sid };
    fs.mkdirSync(path.join(claudeRoot, 'proj'), { recursive: true });
    fs.writeFileSync(path.join(claudeRoot, 'proj', `${sid}.jsonl`), JSON.stringify({ ...base, type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
  };
  mk('sessAcct');
  mk('sessPlain');
  events.append(proj.id, { type: 'session.start', src: 'hook', session: 'sessAcct', data: { source: 'startup', account_id: '1a2b3c4d', plan: 'tier1' } });
  events.append(proj.id, { type: 'session.start', src: 'hook', session: 'sessPlain', data: { source: 'startup' } });
  fs.writeFileSync(path.join(process.env.CREWGATE_HOME, 'accounts.json'), JSON.stringify({ '1a2b3c4d': { email: EMAIL, organization: 'Example Org' } }));
  const board = createBoard({ claudeRoot, codexRoot: null, watcher: { ttlMs: 0 } });
  const port = await board.listen(0);
  try {
    const list = await bh.request(port, { path: '/api/sessions' });
    const rows = list.json.sessions;
    assert.equal(rows.length, 2);
    const withAcct = rows.filter((r) => r.account);
    assert.equal(withAcct.length, 1);
    assert.deepEqual(withAcct[0].account, { id: '1a2b3c4d', plan: 'tier1', email: EMAIL, organization: 'Example Org' });
    const detail = await bh.request(port, { path: `/api/session/${withAcct[0].id}` });
    assert.equal(detail.json.session.account.email, EMAIL);
    const plain = rows.find((r) => !r.account);
    const d2 = await bh.request(port, { path: `/api/session/${plain.id}` });
    assert.ok(!('account' in d2.json.session));
    // a malformed accounts.json: the id still shows, the label does not, nothing fails
    fs.writeFileSync(path.join(process.env.CREWGATE_HOME, 'accounts.json'), '{broken');
    const again = await bh.request(port, { path: '/api/sessions' });
    assert.equal(again.status, 200);
    assert.deepEqual(again.json.sessions.find((r) => r.account).account, { id: '1a2b3c4d', plan: 'tier1' });
  } finally { await board.close(); }
});

test('board UI model: account text, private mode hides the label, no record shows nothing; strings exist in both languages', () => {
  const row = { account: { id: '1a2b3c4d', plan: 'tier1', email: EMAIL, organization: 'Example Org' } };
  assert.equal(SM.accountText(row, false), `${EMAIL} · Example Org · tier1`);
  assert.equal(SM.accountText(row, true), '', 'private mode');
  assert.equal(SM.accountText({ account: { id: '1a2b3c4d', plan: '' } }, false), '#1a2b3c4d');
  assert.equal(SM.accountText({}, false), '');
  assert.equal(SM.accountText({ account: 'x' }, false), '');
  const pub = path.join(__dirname, '..', 'board', 'public');
  for (const l of ['en', 'zh-TW']) assert.match(JSON.parse(fs.readFileSync(path.join(pub, 'i18n', `${l}.json`), 'utf8'))['sessions.account'], /\{who\}/);
  const app = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
  assert.equal((app.match(/SM\.accountText\(/g) || []).length, 2, 'session rows and the session page');
});
