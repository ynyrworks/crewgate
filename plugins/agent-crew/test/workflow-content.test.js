'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'has frontmatter');
  return Object.fromEntries(m[1].split('\n').map((l) => { const i = l.indexOf(':'); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
}

test('plugin agents: frontmatter per the plugin facts; reviewer and refuter are read-only', () => {
  for (const n of ['crew-worker', 'crew-reviewer', 'crew-refuter']) {
    const fm = frontmatter(read('agents', `${n}.md`));
    assert.equal(fm.name, n);
    assert.ok(fm.description.length > 20);
    assert.equal(fm.model, 'sonnet');
    assert.ok(!('hooks' in fm) && !('permissionMode' in fm), 'ignored fields are not used');
    if (n !== 'crew-worker') {
      const tools = fm.tools.split(',').map((x) => x.trim());
      assert.ok(!tools.includes('Edit') && !tools.includes('Write'), `${n} must not edit`);
      assert.deepEqual(tools, ['Read', 'Grep', 'Glob', 'Bash']);
      assert.match(read('agents', `${n}.md`), /Bash is allowed only for/);
    }
  }
});

test('agent templates carry the default worker boundaries (DESIGN section 10)', () => {
  const w = read('templates', 'agents', 'crew-worker.md');
  for (const needle of ['never push', 'No network', 'secrets', 'data files', 'skip tests', 'Must not regress', 'task report', '{{checks_block}}', '{{report_max_tokens}}']) {
    assert.ok(w.includes(needle), `worker template mentions ${needle}`);
  }
  const r = read('templates', 'agents', 'crew-reviewer.md');
  assert.ok(r.includes('not get the worker') && r.includes('verified_by') && r.includes('file:line'));
  assert.ok(read('templates', 'agents', 'crew-refuter.md').includes('upheld|refuted|uncertain'));
});

test('REVIEW.md template: calibration, nit handling, evidence, CI overlap', () => {
  const t = read('templates', 'REVIEW.md');
  for (const needle of ['Severity calibration', 'nit', 'TOCTOU', 'theoretical-race', 'file:line', 'CI']) assert.ok(t.includes(needle), needle);
  assert.match(read('templates', 'LESSONS.md'), /^# Lessons/);
});

test('crew skill: frontmatter, size, sub-commands and every reference exists', () => {
  const text = read('skills', 'crew', 'SKILL.md');
  const fm = frontmatter(text);
  assert.equal(fm.name, 'crew');
  assert.ok(fm.description.includes('分工'));
  assert.ok(text.split('\n').length < 250);
  for (const sub of ['init', 'status', 'wrap-up', 'handoff']) assert.ok(new RegExp(`\\*\\*${sub}\\*\\*`).test(text), sub);
  assert.ok(text.includes('node "${CLAUDE_PLUGIN_ROOT}/bin/crew.js"'));
  for (const m of text.matchAll(/`references\/([\w.-]+\.md)`/g)) {
    assert.ok(fs.existsSync(path.join(ROOT, 'skills', 'crew', 'references', m[1])), m[1]);
  }
  for (const needle of ['max_parallel_workers', 'run_in_background', 'crew task create', 'crew review finalize', 'Promote nothing without a clear yes', 'untrusted']) {
    assert.ok(text.includes(needle), needle);
  }
});

test('every CLI sub-command named in the skill references exists in the command modules', () => {
  const { loadGroup } = require('../lib/core/cli');
  const files = ['SKILL.md', path.join('references', 'commands.md'), path.join('references', 'review-pipeline.md')];
  for (const f of files) {
    const text = read('skills', 'crew', f);
    for (const m of text.matchAll(/`crew (task|review|handoff|lesson|init|doctor)\b/g)) {
      assert.ok(loadGroup(m[1]), `${f}: group ${m[1]}`);
    }
  }
});
