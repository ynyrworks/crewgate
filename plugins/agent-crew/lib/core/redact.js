'use strict';

// Redaction for every text that is stored (events, notes, reports). Always redact first,
// then truncate, so a secret cannot survive by being cut in half.
const net = require('net');

const MASK = '[REDACTED]';
const MASK_IP = '[REDACTED-IP]';

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;
const AUTH_HEADER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi;
// "Authorization: token abc" / "Authorization: Bearer abc" (scheme kept) and "Authorization: abc"
const AUTH_SCHEME = /(\bAuthorization["']?\s*[:=]\s*[A-Za-z][\w-]*[ \t]+)(?!\[REDACTED\])[^\s"',;]+/gi;
const AUTH_BARE = /(\bAuthorization["']?\s*[:=]\s*)(?![A-Za-z][\w-]*[ \t])(?!\[REDACTED\])[^\s"',;]+/gi;
// the keyword may sit anywhere in the name: SECRET_KEY=, DB_PASSWORD_PROD=, api-token:
const KEY_VALUE = /(\b[\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)(?:[_-][\w-]*)?["']?\s*[=:]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&"']+)/gi;
const TOKEN_PATTERNS = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,                 // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,                // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,                  // GitLab
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,              // Slack
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,                   // Anthropic
  /\bsk-[A-Za-z0-9_-]{20,}/g,                       // OpenAI-style
  /\bnpm_[A-Za-z0-9]{30,}\b/g,                      // npm
  /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g,               // Stripe secret / restricted keys
  /\bAIza[0-9A-Za-z_-]{35}\b/g,                     // Google API key
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, // JWT
];

// Four dotted groups; a trailing "." (end of a sentence) is fine, ".5" (a longer version number) is not.
const IPV4 = /(?<![\d.])(\d{1,3})(\.\d{1,3}){3}(?!\d|\.\d)/g;
const V6_RUN = /(?<![A-Za-z0-9_:])[0-9A-Fa-f:.]{3,}(?![A-Za-z0-9_])/g;

function keepV4(ip) {
  const o = ip.split('.').map(Number);
  if (o.some((n) => n > 255)) return true; // not an address at all (e.g. 999.1.1.1)
  if (ip === '127.0.0.1') return true;
  if (o[0] === 192 && o[1] === 0 && o[2] === 2) return true;
  if (o[0] === 198 && o[1] === 51 && o[2] === 100) return true;
  if (o[0] === 203 && o[1] === 0 && o[2] === 113) return true;
  return false;
}

function keepV6(ip) {
  return ip === '::1' || /^2001:0*db8:/i.test(ip);
}

function maskV6(text) {
  return text.replace(V6_RUN, (run) => {
    if ((run.match(/:/g) || []).length < 2 || run === '::') return run;
    const trimmed = run.replace(/\.+$/, '');
    for (const c of [run, trimmed, trimmed.replace(/:$/, '')]) {
      if (c !== '::' && net.isIPv6(c)) return keepV6(c) ? run : MASK_IP + run.slice(c.length);
    }
    return run;
  });
}

// Masks secrets and non-documentation IP addresses. Non-strings give ''.
function redact(text) {
  if (typeof text !== 'string' || text === '') return '';
  let s = text;
  s = s.replace(PRIVATE_KEY, MASK);
  s = s.replace(URL_CREDENTIALS, `$1${MASK}$2`);
  s = s.replace(AUTH_HEADER, `$1 ${MASK}`);
  s = s.replace(AUTH_SCHEME, `$1${MASK}`);
  s = s.replace(AUTH_BARE, `$1${MASK}`);
  s = s.replace(KEY_VALUE,(m, head, value) => {
    if (value === MASK) return m;
    return `${head}${MASK}`;
  });
  for (const re of TOKEN_PATTERNS) s = s.replace(re, MASK);
  s = s.replace(IPV4, (ip) => (keepV4(ip) ? ip : MASK_IP));
  s = maskV6(s);
  return s;
}

// Cuts to at most n characters (an ellipsis counts), never in the middle of a surrogate pair.
function truncate(text, n) {
  const s = typeof text === 'string' ? text : '';
  if (!(n > 0) || s.length <= n) return s;
  let end = n - 1;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, Math.max(end, 0)) + '…';
}

// Redact first, then truncate.
function clean(text, n) {
  return truncate(redact(text), n);
}

module.exports = { redact, truncate, clean, MASK, MASK_IP };
