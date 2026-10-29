'use strict';

// Detects git push / git merge / gh pr create / glab mr create inside a shell command line.
// Quote-aware tokenizer; only command names and branch/remote words are returned.
const MAX_CMD = 20000;
const MAX_TOKENS = 2000;
const OPS = new Set(['&&', '||', ';', '|', '&', '\n', '(', ')']);
const SKIP_WORDS = new Set(['sudo', 'env', 'command', 'time', 'nohup', 'nice', 'exec', 'builtin',
  'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'xargs']);

// Redirections (`2>&1`, `>&2`, `&>f`, `>f`, `2>/dev/null`, `<in`) are not words of the command: the operator and
// its target word are dropped. Heredoc bodies (`<<EOF`, `<<-'EOF'`, ...) are literal text, not commands: they are
// skipped up to the delimiter line.
const DIGITS = /\d/;

// Reads a redirect operator starting at s[i] (after an optional fd number).
// -> { end, target, heredoc } | null. end: index after the operator (and after an attached `&1` / `&-`);
// target: a target word follows (dropped); heredoc: { strip } for `<<` / `<<-` (the next word is the delimiter).
function redirectAt(s, i) {
  let j = i;
  while (DIGITS.test(s[j] || '')) j++;
  const c = s[j];
  if (c !== '>' && c !== '<' && !(c === '&' && s[j + 1] === '>')) return null;
  const fdDup = () => {
    const m = /^&(\d+|-)/.exec(s.slice(j, j + 24));
    if (m) { j += m[0].length; return true; }
    return false;
  };
  if (c === '&') { j += 2; if (s[j] === '>') j++; return { end: j, target: true }; } // &> / &>>
  if (c === '>') {
    j++;
    if (s[j] === '>' || s[j] === '|') j++;
    else if (s[j] === '&') { if (fdDup()) return { end: j, target: false }; j++; }
    return { end: j, target: true };
  }
  j++; // '<'
  if (s[j] === '<') {
    j++;
    if (s[j] === '<') { j++; return { end: j, target: true }; } // here-string: the word is dropped
    let strip = false;
    if (s[j] === '-') { strip = true; j++; }
    return { end: j, target: true, heredoc: { strip } };
  }
  if (s[j] === '>') j++;
  else if (s[j] === '&') { if (fdDup()) return { end: j, target: false }; j++; }
  return { end: j, target: true };
}

// Index of the last char of the heredoc bodies that start after the newline at s[nl].
// Safety rule: when a terminator line cannot be found, nothing is skipped for that heredoc (and the ones after
// it): scanning the rest may give a false event, swallowing it could hide a real push.
function skipHeredocs(s, nl, pending) {
  let pos = nl + 1;
  for (const h of pending) {
    let p = pos;
    let found = false;
    while (p < s.length) {
      let e = s.indexOf('\n', p);
      if (e < 0) e = s.length;
      let line = s.slice(p, e).replace(/\r$/, '');
      if (h.strip) line = line.replace(/^\t+/, '');
      p = e + 1;
      if (line === h.delim) { found = true; break; }
    }
    if (!found) return pos - 1;
    pos = p;
  }
  return Math.min(pos, s.length) - 1;
}

function tokenize(cmd) {
  const toks = [];
  let cur = '';
  let has = false;
  let skipNext = false;   // the next word is a redirect target
  let hereNext = null;    // the next word is a heredoc delimiter: { strip }
  let quoted = false;     // the current word has a quoted part
  const heredocs = [];    // delimiters whose bodies follow the next newline
  const flush = () => {
    if (has) {
      // bash: a quoted delimiter is literal; backslash-quoting is removed only from an unquoted one
      if (hereNext) { heredocs.push({ delim: quoted ? cur : cur.split('\\').join(''), strip: hereNext.strip }); hereNext = null; skipNext = false; }
      else if (skipNext) skipNext = false;
      else toks.push(cur);
    }
    cur = ''; has = false; quoted = false;
  };
  const op = (o) => { skipNext = false; hereNext = null; toks.push({ op: o }); };
  const s = String(cmd).slice(0, MAX_CMD);
  for (let i = 0; i < s.length && toks.length < MAX_TOKENS; i++) {
    const c = s[i];
    let r = null;
    if (c === '>' || c === '<' || (c === '&' && s[i + 1] === '>') || (DIGITS.test(c) && !has)) r = redirectAt(s, i);
    if (c === "'") {
      has = true; quoted = true;
      const j = s.indexOf("'", i + 1);
      cur += s.slice(i + 1, j < 0 ? s.length : j);
      i = j < 0 ? s.length : j;
    } else if (c === '"') {
      has = true; quoted = true;
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '\\' && j + 1 < s.length && '"\\$`'.includes(s[j + 1])) j++;
        cur += s[j];
      }
      i = j;
    } else if (c === '\\' && s[i + 1] === '\n') {
      i++;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      flush();
    } else if (c === '#' && !has) {
      // a comment runs to the end of the line (the newline itself stays an operator)
      const e = s.indexOf('\n', i);
      i = (e < 0 ? s.length : e) - 1;
    } else if (r) {
      flush();
      i = r.end - 1;
      if (r.heredoc) hereNext = r.heredoc;
      else if (r.target) skipNext = true;
    } else if (c === '\n') {
      flush(); op(c);
      if (heredocs.length) i = skipHeredocs(s, i, heredocs.splice(0));
    } else if (c === ';' || c === '(' || c === ')') {
      flush(); op(c);
    } else if (c === '&' || c === '|') {
      flush();
      if (s[i + 1] === c) { op(c + c); i++; } else op(c);
    } else {
      cur += c; has = true;
    }
  }
  flush();
  return toks;
}

function segments(toks) {
  const out = [];
  let cur = [];
  for (const t of toks) {
    if (typeof t === 'object' && OPS.has(t.op)) { if (cur.length) out.push(cur); cur = []; } else cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

const looksLikeUrl = (w) => /:\/\/|@|^[A-Za-z]:[\\/]/.test(w) || /^[^/\s]+:[^/\s]/.test(w);
const isPositional = (w) => !w.startsWith('-');

function pushInfo(args) {
  const info = { remote: null, refs: [], flags: [] };
  const valued = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (isPositional(w)) {
      if (info.remote === null) info.remote = looksLikeUrl(w) ? '(url)' : w;
      else if (info.refs.length < 5) info.refs.push(w);
    } else if (valued.has(w)) {
      i++;
    } else if (/^(-f|--force(-with-lease|-if-includes)?(=.*)?)$/.test(w)) {
      if (!info.flags.includes('force')) info.flags.push('force');
    } else if (w === '-d' || w === '--delete') info.flags.push('delete');
    else if (w === '--tags') info.flags.push('tags');
    else if (w === '--all' || w === '--mirror') info.flags.push(w.slice(2));
    else if (w === '-u' || w === '--set-upstream') info.flags.push('set-upstream');
  }
  return info;
}

// A word the shell has not expanded yet (a loop variable, a command substitution, a Windows variable):
// its text is not a branch name.
const isDynamic = (w) => /[$`]|%[A-Za-z_][^%\s]*%/.test(w);

function mergeInfo(args) {
  const info = { branches: [], flags: [], dynamic: false };
  const valued = new Set(['-m', '-F', '-s', '-X', '--strategy', '--strategy-option', '--into-name', '-S']);
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (isPositional(w)) {
      if (isDynamic(w)) info.dynamic = true;
      else if (info.branches.length < 5) info.branches.push(w);
    }
    else if (valued.has(w)) i++;
    else if (['--abort', '--quit', '--continue'].includes(w)) return null;
    else if (['--no-ff', '--ff-only', '--squash', '--no-commit'].includes(w)) info.flags.push(w.slice(2));
  }
  return info;
}

// Reads `--base x`, `-B x`, `--base=x` style values.
function optValues(args, names) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    const eq = w.indexOf('=');
    const name = eq > 0 ? w.slice(0, eq) : w;
    if (names[name]) {
      const v = eq > 0 ? w.slice(eq + 1) : args[i + 1];
      if (typeof v === 'string') out[names[name]] = v;
    }
  }
  return out;
}

const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']);
const base = (w) => String(w).replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();

function analyse(seg) {
  let i = 0;
  while (i < seg.length) {
    const w = seg[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
    if (SKIP_WORDS.has(w)) {
      i++;
      if (w === 'env' || w === 'sudo' || w === 'nice') while (i < seg.length && seg[i].startsWith('-')) i++;
      continue;
    }
    break;
  }
  const cmd = base(seg[i] || '');
  const rest = seg.slice(i + 1);
  if (cmd === 'git') {
    let j = 0;
    const dirs = []; // every `-C <dir>`, applied in order
    while (j < rest.length && rest[j].startsWith('-')) {
      if (rest[j] === '-C' && j + 1 < rest.length) dirs.push(rest[j + 1]);
      j += GIT_VALUED.has(rest[j]) ? 2 : 1;
    }
    const sub = rest[j];
    const args = rest.slice(j + 1);
    if (sub === 'push') {
      const p = pushInfo(args);
      return { type: 'git.push', data: { command: 'git push', remote: p.remote, refs: p.refs, flags: p.flags }, cd: dirs };
    }
    if (sub === 'merge') {
      const m = mergeInfo(args);
      return m ? { type: 'git.merge', data: { command: 'git merge', branches: m.branches, flags: m.flags, ...(m.dynamic ? { dynamic: true } : {}) }, cd: dirs } : null;
    }
    return null;
  }
  if (cmd === 'gh' || cmd === 'glab') {
    const noun = cmd === 'gh' ? 'pr' : 'mr';
    let j = 0;
    while (j < rest.length && rest[j].startsWith('-')) j += (rest[j] === '-R' || rest[j] === '--repo') ? 2 : 1;
    if (rest[j] !== noun) return null;
    const verb = rest[j + 1];
    const args = rest.slice(j + 2);
    if (verb === 'create') {
      const o = optValues(args, { '--base': 'base', '-B': 'base', '--head': 'head', '-H': 'head', '--target-branch': 'base', '--source-branch': 'head' });
      return { type: 'git.push', data: { command: `${cmd} ${noun} create`, base: o.base || null, head: o.head || null } };
    }
    if (verb === 'merge') return { type: 'git.merge', data: { command: `${cmd} ${noun} merge` } };
  }
  return null;
}

// `cd X` / `pushd X` segment -> the directory word; null when the target is unknown (`popd`, `cd` alone,
// `cd -`, `cd ~`, a dynamic word); undefined when the segment is not a directory change.
function cdTarget(seg) {
  const c = base(seg[0] || '');
  if (c === 'popd') return null;
  if (c !== 'cd' && c !== 'pushd') return undefined;
  const w = seg.slice(1).filter((x) => x !== '--' && !/^-[LPe@]+$/.test(x))[0];
  if (!w || w === '-' || w.startsWith('~') || isDynamic(w)) return null;
  return w;
}

// -> [{ type: 'git.push'|'git.merge', data, cd }]
// cd: the directory words that lead from the session cwd to the repo the command acts on, in order
// (earlier `cd` segments of the command line, then `git -C`). [] = the session cwd. A dynamic or
// unknown directory also gives [] (today's behaviour: the session project).
function detect(command) {
  const out = [];
  let steps = [];
  const saved = []; // steps at each open "(": a subshell's cd ends with its ")"
  let prev = null; // operator before the current segment
  const one = (seg, next) => {
    const t = cdTarget(seg);
    if (t !== undefined) {
      // a cd on either side of | or & runs in a subshell and does not carry on
      if (next !== '|' && next !== '&' && prev !== '|' && prev !== '&') steps = t === null ? [] : [...steps, t];
      return;
    }
    const r = analyse(seg);
    if (r) {
      const own = r.cd || [];
      r.cd = own.some(isDynamic) ? [] : [...steps, ...own];
      out.push(r);
    }
  };
  try {
    let cur = [];
    for (const t of tokenize(command)) {
      if (typeof t === 'object' && OPS.has(t.op)) {
        if (cur.length) one(cur, t.op);
        cur = [];
        if (t.op === '(') saved.push(steps);
        else if (t.op === ')') { if (saved.length) steps = saved.pop(); }
        prev = t.op;
      } else cur.push(t);
      if (out.length >= 5) break;
    }
    if (cur.length && out.length < 5) one(cur, null);
  } catch { /* unparseable: nothing */ }
  return out;
}

// What a finished shell command says about its merges: one entry per merge that happened, in order.
// Reads git's own words ("Merge made by", "Fast-forward", "Squash commit", "Updating a..b").
// -> [{ outcome: 'merge'|'fast-forward'|'squash', range? }] ([] = no merge reported, or no output at all)
function mergesIn(output) {
  const out = [];
  let range = null;
  for (const line of String(output || '').slice(0, 1 << 20).split(/\r?\n/)) {
    const u = /^Updating ([0-9a-f]{7,40}\.\.[0-9a-f]{7,40})\s*$/.exec(line);
    if (u) { range = u[1]; continue; }
    if (/^Fast-forward\b/.test(line)) { out.push({ outcome: 'fast-forward', ...(range ? { range } : {}) }); range = null; }
    else if (/^Merge made by the /.test(line)) out.push({ outcome: 'merge' });
    else if (/^Squash commit -- /.test(line)) out.push({ outcome: 'squash' });
    if (out.length >= 20) break;
  }
  return out;
}

module.exports = { detect, tokenize, mergesIn, isDynamic };
