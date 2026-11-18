'use strict';

// SessionStart: reply-language line on every source, role card on compact and resume only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./hooks-helpers');
const sessionStart = require('../lib/hooks/session-start');
const i18n = require('../lib/core/i18n');

const ctxOf = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
const startWith = (f, source) => ctxOf(H.runHook('session-start', H.base(f, { source }), { cwd: f.repo }));
const cardLines = (text) => {
  const a = text.split('\n');
  const i = a.findIndex((l) => /^(Role card|角色卡)/.test(l));
  return i < 0 ? [] : a.slice(i, a.findIndex((l) => l.startsWith('<crew-state')));
};

for (const source of ['compact', 'resume']) {
  test(`SessionStart ${source}: role card in en, with the limit from config`, () => {
    const f = H.fixture({ config: { limits: { max_parallel_workers: 5 } } });
    const text = startWith(f, source);
    const card = cardLines(text);
    assert.ok(card.length >= 2 && card.length <= 8, `card lines: ${card.length}`);
    const joined = card.join('\n');
    assert.ok(joined.includes('orchestrator') && joined.includes('/crewgate:crew') && joined.includes('/crewgate:plan'));
    assert.ok(joined.includes('At most 5 workers'));
    assert.ok(joined.includes('crew review run') && joined.includes('crew task create'));
    assert.ok(text.indexOf('Role card') < text.indexOf('<crew-state'), 'the card is outside the fence');
    assert.ok(!text.includes('Reply language'), 'no language line for en');
  });

  test(`SessionStart ${source}: role card and language line in zh-TW`, () => {
    const f = H.fixture({ config: { language: 'zh-TW' } });
    const text = startWith(f, source);
    const card = cardLines(text);
    assert.ok(card.length >= 2 && card.length <= 8);
    const joined = card.join('\n');
    assert.ok(joined.includes('統籌') && joined.includes('同時進行的 worker 最多 3 個'));
    assert.ok(text.includes('回覆語言'));
    assert.ok(Buffer.byteLength(text) <= 4000);
  });
}

test('SessionStart startup and clear: no role card; zh-TW adds only the language line', () => {
  const en = H.fixture();
  for (const s of ['startup', 'clear']) assert.deepEqual(cardLines(startWith(en, s)), []);
  const zh = H.fixture({ config: { language: 'zh-TW' } });
  for (const s of ['startup', 'clear']) {
    const text = startWith(zh, s);
    assert.deepEqual(cardLines(text), []);
    assert.ok(text.includes('回覆語言') && !text.includes('crew review run'));
  }
});

test('SessionStart language falls back to the global config when the project has no crew.json', () => {
  const f = H.fixture();
  fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify({ version: 1, language: 'zh-TW' }));
  const text = startWith(f, 'compact');
  assert.ok(text.includes('回覆語言') && text.includes('角色卡'));
});

test('SessionStart cap: a long state block is cut, not the language line or the role card', () => {
  const f = H.fixture({ config: { language: 'zh-TW' } });
  H.start(f);
  const base = H.runHook('session-start', H.base(f, { source: 'compact' }), { cwd: f.repo });
  assert.ok(ctxOf(base).includes('角色卡'));
  const h = {
    pid: f.pid, ctx: { project: { name: 'demo' } }, accountWarn: null,
    cfg: () => ({ limits: { max_parallel_workers: 4 }, lessons: {} }),
    lang: () => 'zh-TW',
    t: (k, v) => (k === 'brief.rules' ? 'x'.repeat(9000) : i18n.t('zh-TW', `hooks.${k}`, v)),
  };
  const text = sessionStart.brief(h, 'compact');
  assert.ok(Buffer.byteLength(text) <= 4000);
  assert.ok(text.includes('回覆語言') && text.includes('同時進行的 worker 最多 4 個') && text.includes('每則訊息的結尾'));
  assert.ok(text.includes('<crew-state untrusted="true">') && text.trimEnd().endsWith('</crew-state>'));
});
