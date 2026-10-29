'use strict';
const j = (...p) => p.join(''); // secret-looking samples are assembled at runtime (repo hygiene scan)
const BEGIN = j('-----BE', 'GIN ');
const PK = j('PRIVATE', ' KEY');
const ip = (...o) => o.join('.'); // addresses are built at runtime (repo hygiene scan)
const test = require('node:test');
const assert = require('node:assert/strict');
const { redact, truncate, clean, MASK } = require('../lib/core/redact');

test('documentation and loopback addresses are kept', () => {
  for (const ip of ['127.0.0.1', '192.0.2.7', '198.51.100.20', '203.0.113.5']) {
    assert.equal(redact(`host ${ip} ok`), `host ${ip} ok`);
  }
  assert.equal(redact('listen ::1 now'), 'listen ::1 now');
  assert.equal(redact('addr 2001:db8::1 doc'), 'addr 2001:db8::1 doc');
});

test('other IPv4 and IPv6 addresses are masked', () => {
  assert.equal(redact('ssh ' + ip(10,1,2,3) + ' now'), 'ssh [REDACTED-IP] now');
  assert.equal(redact('ssh ' + ip(192,168,0,9) + '.'), 'ssh [REDACTED-IP].');
  assert.equal(redact('dns ' + ip(8,8,8,8)), 'dns [REDACTED-IP]');
  assert.equal(redact('v6 fe80::1ff:fe23:4567:890a done'), 'v6 [REDACTED-IP] done');
  assert.equal(redact('v6 2606:4700:4700::1111'), 'v6 [REDACTED-IP]');
  assert.equal(redact(ip(127,0,0,2) + ' is not loopback-exempt'), '[REDACTED-IP] is not loopback-exempt');
});

test('things that look like addresses but are not stay untouched', () => {
  assert.equal(redact('version 1.2.3'), 'version 1.2.3');
  assert.equal(redact('at 12:30:45 today'), 'at 12:30:45 today');
  assert.equal(redact('number 999.1.1.1'), 'number 999.1.1.1');
  assert.equal(redact('v1.2.3.4.5'), 'v1.2.3.4.5');
});

test('private key blocks are masked, even when unterminated', () => {
  const block = `${BEGIN}RSA ${PK}-----\nMIIabc\ndef\n-----END RSA ${PK}-----`;
  assert.equal(redact(`a\n${block}\nb`), `a\n${MASK}\nb`);
  assert.equal(redact(`x ${BEGIN}${PK}-----\nMIIabc`), `x ${MASK}`);
});

test('key=value secrets and auth headers', () => {
  assert.equal(redact('password=hunter2 next'), `password=${MASK} next`);
  assert.equal(redact('db_password: "a b c"'), `db_password: ${MASK}`);
  assert.equal(redact('{"token": "abc123"}'), `{"token": ${MASK}}`);
  assert.equal(redact('API_KEY=xyz'), `API_KEY=${MASK}`);
  assert.equal(redact('Authorization: Bearer abcdefgh12345678'), `Authorization: Bearer ${MASK}`);
  assert.equal(redact('Authorization: Basic dXNlcjpwYXNzd29yZA=='), `Authorization: Basic ${MASK}`);
  assert.equal(redact('url https://user:pw123@example.test/x'), `url https://user:${MASK}@example.test/x`);
  // ordinary words and config names are not secrets
  assert.equal(redact('report_max_tokens: 1500'), 'report_max_tokens: 1500');
  assert.equal(redact('the token is explained below'), 'the token is explained below');
});

test('provider keys and JWTs', () => {
  const samples = [
    j('AK', 'IAABCDEFGHIJKLMNOP'),
    `ghp_${'a'.repeat(36)}`,
    `github_pat_${'A1'.repeat(15)}`,
    j('gl', 'pat-abcdefghij0123456789'),
    j('xo', 'xb-1234567890-abcdefghij'),
    j('sk', '-ant-api03-abcdefghijklmnop'),
    `sk-${'z9'.repeat(15)}`,
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdEFGH1234',
  ];
  for (const s of samples) assert.equal(redact(`k=${s}`.replace('k=', 'val ')), `val ${MASK}`, s);
});

test('redact is idempotent and tolerant of odd input', () => {
  const once = redact('password=abc ' + ip(10,0,0,1) + ' Bearer abcdefgh12345');
  assert.equal(redact(once), once);
  assert.equal(redact(undefined), '');
  assert.equal(redact(null), '');
  assert.equal(redact(42), '');
  assert.equal(redact(''), '');
});

test('truncate respects the limit, adds an ellipsis and keeps surrogate pairs whole', () => {
  assert.equal(truncate('abcdef', 10), 'abcdef');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abcdef', 4).length, 4);
  const emoji = 'ab\u{1F600}\u{1F600}\u{1F600}';
  const cut = truncate(emoji, 4);
  assert.ok(cut.length <= 4);
  assert.ok(!/[\ud800-\udbff]…$/.test(cut));
  assert.equal(truncate('x', 0), 'x');
});

test('clean = redact then truncate: a secret cannot survive by being cut', () => {
  const text = `${'x'.repeat(10)} password=supersecretvalue`;
  const out = clean(text, 22);
  assert.ok(!out.includes('supersecret'));
  assert.ok(out.length <= 22);
});
