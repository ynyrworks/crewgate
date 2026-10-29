'use strict';

// Review pipeline (DESIGN section 9): finding schema, fingerprints, dismissed ledger,
// deterministic filter, refutation merge and prompt builders. No printing here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const json = require('../core/json');
const { redact } = require('../core/redact');
const { CrewError } = require('../core/errors');
const common = require('./common');
const paths = require('../core/paths');

const SEVERITIES = ['blocker', 'major', 'minor', 'nit'];
const VERIFIED_BY = ['repro', 'test', 'code-trace', 'inference'];
const VERDICTS = ['upheld', 'refuted', 'uncertain'];
const MAX_DIFF_BYTES = 200 * 1024;

// ---------------------------------------------------------------- files
function findingsDir(taskDir) { return path.join(taskDir, 'findings'); }

// Highest round number that has a file with this suffix (e.g. "raw.json"), or 0.
function latestRound(taskDir, suffix) {
  let names = [];
  try { names = fs.readdirSync(findingsDir(taskDir)); } catch { return 0; }
  let max = 0;
  for (const n of names) {
    const m = /^(\d+)\.(.+)$/.exec(n);
    if (m && m[2] === suffix) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function roundFile(taskDir, round, suffix) { return path.join(findingsDir(taskDir), `${round}.${suffix}`); }

function readArray(file, what) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    throw new CrewError('wf.review.noFile', { what, file });
  }
  const data = common.parseJsonText(raw, what);
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.findings) ? data.findings : null);
  if (!list) throw new CrewError('wf.review.notArray', { what });
  return list;
}

// ---------------------------------------------------------------- schema
// -> list of problem strings (empty when the finding is valid)
function validateFinding(f, categories) {
  const p = [];
  if (!f || typeof f !== 'object' || Array.isArray(f)) return ['not an object'];
  const str = (k) => typeof f[k] === 'string' && f[k].trim() !== '';
  if (!str('id')) p.push('id: required string');
  if (!str('category')) p.push('category: required string');
  else if (!categories.includes(f.category)) p.push(`category: "${f.category}" is not one of ${categories.join(', ')}`);
  if (!SEVERITIES.includes(f.severity)) p.push(`severity: must be one of ${SEVERITIES.join(', ')}`);
  if (!str('file')) p.push('file: required string');
  if (!Number.isInteger(f.line) || f.line < 1) p.push('line: must be a positive integer');
  if (f.symbol !== undefined && typeof f.symbol !== 'string') p.push('symbol: must be a string');
  if (!str('snippet')) p.push('snippet: required string');
  if (!str('claim')) p.push('claim: required string');
  if (!Array.isArray(f.evidence) || !f.evidence.length || f.evidence.some((e) => typeof e !== 'string' || !e.trim())) {
    p.push('evidence: needs at least one "file:line" string');
  }
  if (!VERIFIED_BY.includes(f.verified_by)) p.push(`verified_by: must be one of ${VERIFIED_BY.join(', ')}`);
  if (typeof f.confidence !== 'number' || !(f.confidence >= 0 && f.confidence <= 1)) p.push('confidence: must be a number from 0 to 1');
  if (f.suggestion !== undefined && typeof f.suggestion !== 'string') p.push('suggestion: must be a string');
  return p;
}

// ---------------------------------------------------------------- fingerprint and ledger
function normSnippet(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function normFile(s) { return String(s || '').replace(/\\/g, '/'); }

function fingerprint(f) {
  const raw = [f.category, normFile(f.file), f.symbol || '', normSnippet(f.snippet)].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// The ledger is committed to git, so it never stores snippet text. For `once` entries it keeps a
// sha256 of the whitespace-normalised snippet (first SNIPPET_CAP characters) and that text's byte
// length. "Is the snippet still there?" = does any window of that many bytes of the normalised
// file hash to the same value. Cost: one sha256 per byte offset, so files over MAX_SCAN_BYTES
// (normalised) are not scanned and a `once` entry then simply stops matching (fails open).
const SNIPPET_CAP = 500;
const MAX_SCAN_BYTES = 512 * 1024;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function snippetDigest(snippet) {
  const text = Array.from(normSnippet(snippet)).slice(0, SNIPPET_CAP).join('');
  const buf = Buffer.from(text, 'utf8');
  if (!buf.length) return null;
  return { snippet_hash: sha(buf), snippet_bytes: buf.length };
}

function windowPresent(fileText, digest) {
  const buf = Buffer.from(normSnippet(fileText), 'utf8');
  const m = digest.snippet_bytes;
  if (!(m > 0) || buf.length < m || buf.length > MAX_SCAN_BYTES) return false;
  for (let i = 0; i + m <= buf.length; i++) {
    if (buf[i] === 0x20) continue; // a normalised snippet never starts with a space
    if (sha(buf.subarray(i, i + m)) === digest.snippet_hash) return true;
  }
  return false;
}

// Called before anything about a finding is written under the task dir: fingerprint and snippet
// digest are taken from the raw text, then the free-text fields are redacted. With `force` the
// derived fields are recomputed (submit, engine output); otherwise existing ones are kept so a
// second pass over an already redacted finding does not change its fingerprint.
function sanitizeFinding(f, force) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return f;
  const out = { ...f };
  if (typeof f.snippet === 'string' && f.snippet.trim() && typeof f.file === 'string') {
    if (force || typeof out.fingerprint !== 'string') out.fingerprint = fingerprint(f);
    const d = snippetDigest(f.snippet);
    if (d && (force || typeof out.snippet_hash !== 'string')) Object.assign(out, d);
  }
  for (const k of ['snippet', 'claim', 'suggestion']) if (typeof out[k] === 'string') out[k] = redact(out[k]);
  if (Array.isArray(out.evidence)) out.evidence = out.evidence.map((e) => (typeof e === 'string' ? redact(e) : e));
  return out;
}

function sanitizeFindings(list, force) { return list.map((f) => sanitizeFinding(f, force)); }

function sanitizeRefutation(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return r;
  const out = { ...r };
  if (typeof out.evidence === 'string') out.evidence = redact(out.evidence);
  else if (Array.isArray(out.evidence)) out.evidence = out.evidence.map((e) => (typeof e === 'string' ? redact(e) : e));
  for (const k of ['claim', 'reason', 'suggestion']) if (typeof out[k] === 'string') out[k] = redact(out[k]);
  return out;
}

function fingerprintOf(f) { return typeof f.fingerprint === 'string' && f.fingerprint ? f.fingerprint : fingerprint(f); }

function ledgerFile(root) { return path.join(root, '.crew', 'dismissed.jsonl'); }

function readLedger(root) {
  let raw = '';
  try { raw = fs.readFileSync(ledgerFile(root), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e.fingerprint === 'string' && (e.scope === 'once' || e.scope === 'always')) out.push(e);
    } catch { /* skip a malformed line */ }
  }
  return out;
}

function appendLedger(root, entry) {
  const file = ledgerFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch { cur = ''; }
  if (cur && !cur.endsWith('\n')) cur += '\n';
  const { snippet, ...safe } = entry; // never write snippet text
  json.saveRaw(file, `${cur}${JSON.stringify(safe)}\n`);
}

// Does the snippet still occur in the file? The file must stay inside the base dir.
// Uses the digest (ledger entry first, then the finding); an old entry or finding without a digest
// falls back to the snippet text. `entry` is optional.
function snippetPresent(baseDirs, f, entry) {
  let digest = null;
  for (const src of [entry, f]) {
    if (src && typeof src.snippet_hash === 'string' && src.snippet_bytes > 0) { digest = src; break; }
  }
  const want = digest ? '' : normSnippet(f.snippet || (entry && entry.snippet));
  if (!digest && !want) return false;
  for (const dir of baseDirs) {
    if (!dir) continue;
    const abs = path.resolve(dir, normFile(f.file));
    if (paths.isOutside(path.relative(path.resolve(dir), abs))) continue;
    try {
      const text = fs.readFileSync(abs, 'utf8');
      if (digest ? windowPresent(text, digest) : normSnippet(text).includes(want)) return true;
    } catch { /* try the next base */ }
  }
  return false;
}

// -> the ledger entry that suppresses this finding, or null. `once` only while the snippet still exists.
function matchLedger(ledger, f, baseDirs) {
  const fp = fingerprintOf(f);
  for (const e of ledger) {
    if (e.fingerprint !== fp) continue;
    if (e.scope === 'always') return e;
    if (snippetPresent(baseDirs, f, e)) return e;
  }
  return null;
}

// ---------------------------------------------------------------- filter
// filterFindings(list, { cfg, ledger, baseDirs }) -> { kept, dropped: [{ finding, reason }] }
// Order: schema, ledger, inference, confidence, downgrade, nit cap.
function filterFindings(list, { cfg, ledger = [], baseDirs = [] }) {
  const rv = cfg.review;
  const dropped = [];
  const kept = [];
  const seen = new Set();
  for (const f of list) {
    const problems = validateFinding(f, rv.categories);
    if (!problems.length && seen.has(f.id)) problems.push(`id: duplicate "${f.id}"`);
    if (problems.length) { dropped.push({ finding: f, reason: 'invalid', detail: problems.join('; ') }); continue; }
    seen.add(f.id);
    const hit = matchLedger(ledger, f, baseDirs);
    if (hit) { dropped.push({ finding: f, reason: 'dismissed', detail: `${hit.scope}: ${hit.reason || ''}`.trim() }); continue; }
    if (f.verified_by === 'inference' && !rv.report_inference) { dropped.push({ finding: f, reason: 'inference' }); continue; }
    if (f.confidence < rv.min_confidence) { dropped.push({ finding: f, reason: 'low-confidence', detail: `${f.confidence} < ${rv.min_confidence}` }); continue; }
    let item = f;
    const patterns = [f.pattern, ...(Array.isArray(f.tags) ? f.tags : [])].filter((x) => typeof x === 'string');
    const hitPattern = rv.downgrade_to_nit.find((p) => patterns.includes(p) || f.category === p);
    if (hitPattern && f.verified_by !== 'repro' && f.category !== 'nit') {
      item = { ...f, category: 'nit', severity: 'nit', downgraded_from: { category: f.category, severity: f.severity, pattern: hitPattern } };
    }
    kept.push(item);
  }
  // cap nits: highest confidence first, the rest are dropped
  const nits = kept.filter((f) => f.category === 'nit').sort((a, b) => b.confidence - a.confidence);
  const over = new Set(nits.slice(rv.nit_cap).map((f) => f.id));
  const finalKept = [];
  for (const f of kept) {
    if (over.has(f.id)) dropped.push({ finding: f, reason: 'nit-cap', detail: `cap ${rv.nit_cap}` });
    else finalKept.push(f);
  }
  return { kept: finalKept, dropped };
}

// ---------------------------------------------------------------- refutations
// finalize(kept, refutations, cfg) -> { findings, dropped, problems }
// upheld/uncertain survive; refuted ones are dropped. A finding without a usable verdict stays as uncertain.
function applyRefutations(kept, refutations) {
  const problems = [];
  const byId = new Map();
  for (const r of refutations) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !VERDICTS.includes(r.verdict)) {
      problems.push(`bad refutation entry: ${JSON.stringify(r).slice(0, 120)}`);
      continue;
    }
    if (r.verdict === 'refuted' && !(typeof r.evidence === 'string' ? r.evidence.trim() : (Array.isArray(r.evidence) && r.evidence.length))) {
      problems.push(`refutation of ${r.id} has no evidence; treated as uncertain`);
      byId.set(r.id, { ...r, verdict: 'uncertain' });
      continue;
    }
    byId.set(r.id, r);
  }
  const ids = new Set(kept.map((f) => f.id));
  for (const id of byId.keys()) if (!ids.has(id)) problems.push(`refutation for unknown finding: ${id}`);
  const findings = [];
  const dropped = [];
  for (const f of kept) {
    const r = byId.get(f.id);
    if (!r) {
      problems.push(`no refutation for ${f.id}; kept as uncertain`);
      findings.push({ ...f, verdict: 'uncertain', refutation: 'not checked' });
    } else if (r.verdict === 'refuted') {
      dropped.push({ finding: f, reason: 'refuted', detail: Array.isArray(r.evidence) ? r.evidence.join('; ') : String(r.evidence) });
    } else {
      findings.push({ ...f, verdict: r.verdict, refutation: r.evidence === undefined ? '' : r.evidence });
    }
  }
  return { findings, dropped, problems };
}

// ---------------------------------------------------------------- JSON extraction
// Pulls the first JSON array out of an engine's stdout (plain, fenced or surrounded by prose).
function extractJsonArray(text) {
  const s = String(text || '');
  const tryParse = (x) => { try { const v = JSON.parse(x); return Array.isArray(v) ? v : null; } catch { return null; } };
  let r = tryParse(s.trim());
  if (r) return r;
  for (const m of s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    r = tryParse(m[1].trim());
    if (r) return r;
  }
  // balanced scan from each "[" that starts a line or follows prose
  for (let i = s.indexOf('['); i >= 0; i = s.indexOf('[', i + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) { r = tryParse(s.slice(i, j + 1)); if (r) return r; break; } }
    }
  }
  return null;
}

// ---------------------------------------------------------------- prompts
const SCHEMA_TEXT = [
  'Output a JSON array. Each element:',
  '{ "id": "f1", "category": "<allowed category>", "severity": "blocker|major|minor|nit",',
  '  "file": "path/relative/to/repo", "line": 12, "symbol": "functionName", "snippet": "the offending code, copied exactly",',
  '  "claim": "one sentence: what is wrong and why it matters",',
  '  "evidence": ["path/file.js:34", "..."], "verified_by": "repro|test|code-trace|inference",',
  '  "confidence": 0.0-1.0, "suggestion": "optional fix" }',
  'Report only problems backed by file:line evidence. Return [] when there is nothing worth reporting.',
].join('\n');

function reviewerInstructions({ task, briefPath, reviewPath, diffCmd, categories, round, rawPath, cli }) {
  return [
    `crew-task: ${task.id}`,
    `You are the crew reviewer for task ${task.id} (round ${round}). You are read-only: do not edit any file.`,
    `Read, in this order: the brief (${briefPath}), the review rules (${reviewPath}), then the change: ${diffCmd}.`,
    'You deliberately do NOT get the worker\'s own description of its work; judge the diff against the brief.',
    `Allowed categories: ${categories.join(', ')}.`,
    SCHEMA_TEXT,
    `Save the array by piping it to: ${cli} review submit ${task.id} --round ${round}  (JSON on stdin; it is stored as ${rawPath}).`,
    'Your final message must only say how many findings you saved.',
  ].join('\n');
}

function refuterInstructions({ task, briefPath, reviewPath, diffCmd, keptPath, round, cli }) {
  return [
    `crew-task: ${task.id}`,
    `You are the crew refuter for task ${task.id} (round ${round}). You are read-only: do not edit any file.`,
    `Read the surviving findings (${keptPath}), the brief (${briefPath}), the review rules (${reviewPath}) and the change: ${diffCmd}.`,
    'Try to DISPROVE each finding using only those sources: is the claim false, already handled elsewhere in the diff, out of scope, or covered by the rules?',
    'Output a JSON array with one element per finding: { "id": "<finding id>", "verdict": "upheld|refuted|uncertain", "evidence": "file:line and one sentence" }.',
    'Use "refuted" only with concrete evidence; use "uncertain" when you cannot decide.',
    `Save it by piping it to: ${cli} review submit ${task.id} --round ${round} --kind refutations  (JSON on stdin).`,
    'Your final message must only say how many verdicts you saved.',
  ].join('\n');
}

module.exports = {
  SEVERITIES, VERIFIED_BY, VERDICTS, MAX_DIFF_BYTES, findingsDir, latestRound, roundFile, readArray,
  validateFinding, normSnippet, fingerprint, fingerprintOf, snippetDigest, sanitizeFinding, sanitizeFindings, sanitizeRefutation, ledgerFile, readLedger, appendLedger, snippetPresent,
  SCHEMA_TEXT, matchLedger, filterFindings, applyRefutations, extractJsonArray, reviewerInstructions, refuterInstructions,
};
