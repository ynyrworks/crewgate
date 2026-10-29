'use strict';

// Scans every file git knows about (tracked, plus untracked-but-not-ignored) for things that must
// never ship: project/author names, stray IP addresses, private keys and credential-looking strings.
// A line may opt out with the inline marker below; the number of opt-outs is capped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const j = (...p) => p.join('');
const MARKER = j('hygiene', '-allow');
const MAX_ALLOWED = 5; // exclusive upper bound: fewer than 5 opt-outs in the whole repo

// Patterns are assembled from fragments so this file does not match itself.
const NAMES = [j('che', 'oyu'), j('whatsmy', 'agentdoing'), j('my', 'office'), j('dev', 'board')]
  .map((n) => ({ name: 'forbidden name', re: new RegExp(n, 'i') }));

const KEY_BLOCK = { name: 'private key block', re: new RegExp(j('-----BEGIN [A-Z ]*', 'PRIVATE KEY-----')) };
const TOKENS = [
  { name: 'GitHub token', re: new RegExp(j('gh', 'p_[A-Za-z0-9]{20,}')) },
  { name: 'GitLab token', re: new RegExp(j('gl', 'pat-[A-Za-z0-9_-]{15,}')) },
  { name: 'Slack token', re: new RegExp(j('xo', 'x[bp]-[A-Za-z0-9-]{10,}')) },
  { name: 'Anthropic key', re: new RegExp(j('sk', '-ant-[A-Za-z0-9_-]{10,}')) },
  { name: 'API secret key', re: new RegExp(j('(?<![A-Za-z0-9_-])sk', '-[A-Za-z0-9]{20,}')) },
  { name: 'AWS access key id', re: new RegExp(j('AK', 'IA[0-9A-Z]{16}')) },
];

const IP_RE = /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w]|\.\d)/g;
function ipAllowed(o) {
  if (o.some((n) => n > 255)) return true; // not an address (e.g. a version-like string)
  const [a, b, c, d] = o;
  if (a === 127 && b === 0 && c === 0 && d === 1) return true;
  if (a === 0 && b === 0 && c === 0 && d === 0) return true;
  return (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.zip', '.gz', '.woff', '.woff2', '.ttf', '.pdf']);

function files() {
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ls-files failed: ${r.stderr}`);
  return r.stdout.split('\0').filter(Boolean).filter((f) => fs.existsSync(path.join(ROOT, f)));
}

function scan() {
  const hits = [];
  let allowed = 0;
  const all = files();
  for (const rel of all) {
    if (SKIP_EXT.has(path.extname(rel).toLowerCase())) continue;
    const full = path.join(ROOT, rel);
    let buf;
    try { buf = fs.readFileSync(full); } catch { continue; }
    if (buf.length > 4 * 1024 * 1024 || buf.includes(0)) continue;
    const lines = buf.toString('utf8').split(/\r?\n/);
    const self = path.resolve(full) === path.resolve(__filename);
    lines.forEach((line, i) => {
      if (!self && line.includes(MARKER)) { allowed++; return; }
      if (self) return; // the scanner itself carries no secrets; its patterns are obfuscated anyway
      const where = `${rel}:${i + 1}`;
      for (const p of [...NAMES, KEY_BLOCK, ...TOKENS]) if (p.re.test(line)) hits.push(`${where}: ${p.name}`);
      for (const m of line.matchAll(IP_RE)) {
        const o = m.slice(1, 5).map(Number);
        if (!ipAllowed(o)) hits.push(`${where}: IPv4 address ${m[0]}`);
      }
    });
  }
  return { hits, allowed, count: all.length };
}

test('no forbidden names, stray IP addresses, keys or tokens in the repository', () => {
  const { hits, count } = scan();
  assert.ok(count > 50, `expected to scan the whole repo, saw ${count} files`);
  assert.deepEqual(hits, [], `hygiene problems:\n${hits.join('\n')}`);
});

test('the allow-list stays tiny', () => {
  const { allowed } = scan();
  assert.ok(allowed < MAX_ALLOWED, `${allowed} lines use the ${MARKER} marker; the cap is ${MAX_ALLOWED - 1}`);
});

test('the scanner itself catches what it should', () => {
  const sample = (re, s) => re.test(s);
  assert.ok(sample(KEY_BLOCK.re, j('-----BEGIN RSA ', 'PRIVATE KEY-----')));
  assert.ok(sample(TOKENS[0].re, j('gh', 'p_', 'a'.repeat(30))));
  assert.ok(sample(TOKENS[3].re, j('sk', '-ant-', 'abcdefghijkl')));
  assert.ok(sample(TOKENS[5].re, j('AK', 'IA', 'ABCDEFGHIJKLMNOP')));
  assert.ok(NAMES.some((n) => n.re.test(j('Dev', 'Board'))));
  assert.equal(ipAllowed([10, 1, 2, 3]), false);
  assert.equal(ipAllowed([192, 0, 2, 7]), true);
  assert.equal(ipAllowed([198, 51, 100, 9]), true);
  assert.equal(ipAllowed([127, 0, 0, 1]), true);
  assert.equal(ipAllowed([127, 0, 0, 2]), false);
});
