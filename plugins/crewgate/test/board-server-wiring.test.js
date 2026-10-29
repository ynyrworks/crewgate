'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./board-helpers');

h.setupHome();
const { createBoard } = require('../board/server');
const projects = require('../lib/core/project');
const events = require('../lib/core/events');
const paths = require('../lib/core/paths');

const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

function transcript(root, sid, ageMin, extra = []) {
  const t = Date.now() - ageMin * MIN;
  const f = path.join(root, 'proj', `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const lines = [
    { type: 'user', cwd: '/tmp/x', timestamp: iso(t - 1000), message: { role: 'user', content: 'hi' } },
    { type: 'assistant', cwd: '/tmp/x', timestamp: iso(t), message: { role: 'assistant', model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
    ...extra,
  ];
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.utimesSync(f, new Date(t), new Date(t));
}

test('the server wires the session.end index and the board thresholds into the watcher', async () => {
  const claudeRoot = h.tmpDir('crew-sw-claude-');
  const codexRoot = h.tmpDir('crew-sw-codex-');
  const proj = projects.add(h.makeRepo(), { name: 'demo' }).project;
  transcript(claudeRoot, 'ended', 5);
  transcript(claudeRoot, 'quiet', 5);                                              // waiting 5 min, idle limit is 1 min
  transcript(claudeRoot, 'closed', 10, [{ type: 'last-prompt' }, { type: 'cost-state' }]);
  events.append(proj.id, { type: 'session.end', src: 'hook', session: 'ended', data: {} });
  fs.writeFileSync(paths.configFile(), JSON.stringify({ version: 1, board: { session_idle_minutes: 1 } }));
  const board = createBoard({ claudeRoot, codexRoot, watcher: { ttlMs: 0 } });
  try {
    const port = await board.listen(0);
    const r = await h.request(port, { path: '/api/sessions' });
    assert.equal(r.status, 200);
    // folder is the same for all three; tell them apart by status
    assert.deepEqual(r.json.sessions.map((s) => s.status).sort(), ['done', 'idle', 'idle']);
    // 'closed' stays idle (not done): detect_closed_transcripts is off by default
    fs.writeFileSync(paths.configFile(), JSON.stringify({ version: 1, board: { session_idle_minutes: 1, detect_closed_transcripts: true } }));
    const r2 = await h.request(port, { path: '/api/sessions' });
    assert.deepEqual(r2.json.sessions.map((s) => s.status).sort(), ['done', 'done', 'idle']);
  } finally { await board.close(); }
});
