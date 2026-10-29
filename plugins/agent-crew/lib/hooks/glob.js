'use strict';

// Tiny glob matcher for orchestrator_edit_allow: `**` (any depth), `*` (no slash), `?` (one char).
// Patterns without a slash match at any depth, like gitignore. Paths use forward slashes.
const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

function segment(seg) {
  let out = '';
  for (const c of seg) out += c === '*' ? '[^/]*' : c === '?' ? '[^/]' : esc(c);
  return out;
}

function toRegex(glob, ci) {
  let g = String(glob || '').slice(0, 300).replace(/\\/g, '/');
  while (g.startsWith('./')) g = g.slice(2);
  g = g.replace(/^\/+/, '');
  const segs = g.split('/').filter(Boolean);
  if (!segs.length) return null;
  let re = g.includes('/') ? '^' : '^(?:[^/]+/)*';
  segs.forEach((s, i) => {
    const last = i === segs.length - 1;
    if (s === '**') re += last ? '.*' : '(?:[^/]+/)*';
    else re += segment(s) + (last ? '' : '/');
  });
  return new RegExp(`${re}$`, ci ? 'i' : '');
}

function matchAny(globs, relPath, ci) {
  const p = String(relPath).replace(/\\/g, '/').replace(/^\.\//, '');
  for (const g of Array.isArray(globs) ? globs : []) {
    try { const re = toRegex(g, ci); if (re && re.test(p)) return true; } catch { /* bad pattern: ignore */ }
  }
  return false;
}

module.exports = { toRegex, matchAny };
