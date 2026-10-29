'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { render, OUT } = require('../scripts/gen-config-docs');
const config = require('../plugins/crewgate/lib/core/config');

test('docs/CONFIG.md is up to date (run node scripts/gen-config-docs.js)', () => {
  assert.equal(fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n'), render());   // a CRLF checkout (autocrlf) is fine
});

test('every schema key appears in the generated reference', () => {
  const text = render();
  for (const e of [...config.SCHEMA, ...config.GLOBAL_SCHEMA]) assert.ok(text.includes(`\`${e.path}\``), e.path);
});
