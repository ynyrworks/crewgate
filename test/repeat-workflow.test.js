'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const text = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'repeat.yml'), 'utf8');

test('repeat.yml: name and both triggers', () => {
  assert.match(text, /^name: Repeat$/m);
  assert.match(text, /^on:\n {2}push:\n {4}branches:\n {6}- 'repeat\/\*\*'/m);
  assert.match(text, /^ {2}workflow_dispatch:/m);
  assert.match(text, /^ {6}count:[\s\S]*?default: '10'/m);
  assert.match(text, /^ {6}nodes:[\s\S]*?default: '\[18, 20\]'/m);
});

test('repeat.yml: Windows job, no fail-fast, 30 minute limit, read-only token', () => {
  assert.match(text, /runs-on: windows-latest/);
  assert.match(text, /fail-fast: false/);
  assert.match(text, /timeout-minutes: 30/);
  assert.match(text, /^permissions:\n {2}contents: read$/m);
  assert.match(text, /cancel-in-progress: true/);
  assert.match(text, /fromJSON\(needs\.plan\.outputs\.nodes\)/);
});

test('repeat.yml: count limit of 20 and node list limit of 3', () => {
  assert.match(text, /count > 20/);
  assert.match(text, /nodes\.length > 3/);
});

test('repeat.yml: no continue-on-error, no retry, no secrets, cache or upload', () => {
  assert.ok(!text.includes('continue-on-error'));
  assert.ok(!/retry/i.test(text));
  assert.ok(!/secrets\./.test(text));
  assert.ok(!/actions\/(cache|upload-artifact)/.test(text));
});
