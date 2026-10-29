(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SessionsModel = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Pure helpers for the Sessions page (no DOM): filtering, sorting, the parent/child tree and the
  // private-mode rules. app.js renders what these return.

  var RUNNING = ['working', 'tool'];
  var STATES = ['all', 'running', 'waiting'];
  var ENGINES = ['all', 'claude', 'codex'];

  function isRunning(r) { return RUNNING.indexOf(r.status) >= 0; }
  // A subagent that ended its turn is reporting back to its parent, not waiting for the user.
  function displayStatus(r) { return r.subagent && r.status === 'waiting' ? 'done' : r.status; }
  function isWaiting(r) { return r.status === 'waiting' && !r.subagent; }

  // Anything stored in the browser is untrusted input: fall back to "all" for unknown values.
  function cleanFilter(f) {
    f = f && typeof f === 'object' ? f : {};
    return {
      project: typeof f.project === 'string' ? f.project.slice(0, 40) : '',
      state: STATES.indexOf(f.state) >= 0 ? f.state : 'all',
      engine: ENGINES.indexOf(f.engine) >= 0 ? f.engine : 'all'
    };
  }

  function matches(r, f) {
    if (f.engine !== 'all' && r.engine !== f.engine) return false;
    if (f.project === '-') { if (r.project) return false; } else if (f.project && r.project !== f.project) return false;
    if (f.state === 'running') return isRunning(r);
    if (f.state === 'waiting') return isWaiting(r);
    return true;
  }

  function byImportance(a, b) {
    var wa = isWaiting(a.row) ? 0 : 1;
    var wb = isWaiting(b.row) ? 0 : 1;
    if (wa !== wb) return wa - wb;
    return String(b.row.lastActivity).localeCompare(String(a.row.lastActivity));
  }

  // buildTree(rows, filter) -> [{ row, children: [...], running }]. A subagent hangs under its parent
  // when the parent row is present; otherwise it is a top-level entry. A row that passes the filter
  // pulls its ancestors in, so the tree stays connected. `running` counts all running children of the
  // row (before filtering). Waiting-for-you entries come first at every level.
  function buildTree(rows, filter) {
    var f = cleanFilter(filter);
    var byId = {};
    rows.forEach(function (r) { byId[r.id] = r; });
    var parentOf = function (r) { return r.parent && r.parent !== r.id && byId[r.parent] ? byId[r.parent] : null; };
    var keep = {};
    rows.forEach(function (r) {
      if (!matches(r, f)) return;
      var cur = r;
      for (var i = 0; cur && i < 8 && !keep[cur.id]; i++) { keep[cur.id] = true; cur = parentOf(cur); }
    });
    var nodes = {};
    rows.forEach(function (r) { nodes[r.id] = { row: r, children: [], running: 0 }; });
    var top = [];
    rows.forEach(function (r) {
      var p = parentOf(r);
      if (p && isRunning(r)) nodes[p.id].running++;
    });
    rows.forEach(function (r) {
      if (!keep[r.id]) return;
      var p = parentOf(r);
      if (p) nodes[p.id].children.push(nodes[r.id]); else top.push(nodes[r.id]);
    });
    var sortDeep = function (list) { list.sort(byImportance); list.forEach(function (n) { sortDeep(n.children); }); };
    sortDeep(top);
    return top;
  }

  // Is a node expanded? An explicit choice wins; otherwise open while a child is running.
  function isOpen(node, choices) {
    var c = choices && choices[node.row.id];
    if (c === true || c === false) return c;
    return node.running > 0;
  }

  // What may be shown for a row. Private mode only ever removes things: the server already left
  // out text that board.show_text does not allow, and this never adds any.
  function visible(row, priv) {
    var act = row.activity || {};
    var task = row.task || null;
    return {
      prompt: priv ? null : row.last_prompt || null,
      reply: priv ? null : row.last_reply || null,
      title: priv ? null : row.title || null,
      target: priv ? null : act.target || null,
      taskTitle: priv || !task ? null : task.title || null,
      branch: priv ? null : row.branch || null,
      worktree: priv ? null : row.worktree || null,
      folder: priv ? null : row.folder || null
    };
  }

  function counts(rows) {
    var c = { all: rows.length, running: 0, waiting: 0 };
    rows.forEach(function (r) { if (isRunning(r)) c.running++; if (isWaiting(r)) c.waiting++; });
    return c;
  }

  // ---- statistics (numbers only; the server computes them) and the activity timeline

  // 4m 12s / 1h 05m / 2d 3h; under a second is "<1s".
  function fmtDuration(ms) {
    if (!isFinite(ms) || ms < 0) return '–';
    var s = Math.floor(ms / 1000);
    if (s < 1) return ms > 0 ? '<1s' : '0s';
    var d = Math.floor(s / 86400);
    var hr = Math.floor((s % 86400) / 3600);
    var mi = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (d) return d + 'd ' + hr + 'h';
    if (hr) return hr + 'h ' + (mi < 10 ? '0' : '') + mi + 'm';
    if (mi) return mi + 'm ' + (sec < 10 ? '0' : '') + sec + 's';
    return sec + 's';
  }

  // 950 -> 950, 12345 -> 12.3k, 3400000 -> 3.4M
  function compact(n) {
    n = Number(n) || 0;
    if (n < 1000) return String(n);
    if (n < 999500) return (n / 1e3 < 100 ? Math.round(n / 100) / 10 : Math.round(n / 1e3)) + 'k';
    if (n < 1e9) return (n / 1e6 < 100 ? Math.round(n / 1e5) / 10 : Math.round(n / 1e6)) + 'M';
    return Math.round(n / 1e8) / 10 + 'G';
  }

  function tokenSum(tk) { return tk ? (tk.input || 0) + (tk.output || 0) + (tk.cache_write || 0) + (tk.cache_read || 0) : 0; }

  // What a session card shows: the totals of a parent (itself plus its subagents) when it has any,
  // otherwise its own numbers. null while the server has no statistics for the row.
  function cardStats(row) {
    var own = row && row.stats;
    if (!own) return null;
    var s = row.totals || own;
    return {
      duration: s.duration_ms, prompts: s.prompts, tools: s.tool_calls, tokens: tokenSum(s.tokens), cost: s.cost,
      costComplete: s.cost_complete !== false, partial: !!s.partial, sessions: row.totals ? row.totals.sessions : 1
    };
  }

  var KIND_ORDER = ['prompt', 'tool', 'subagent', 'crew', 'error'];

  // Timeline state: { events (oldest first), cursor, cursor_ts }. The newest page is fetched again on every
  // refresh and merged in; older pages are prepended by "load more".
  function emptyTimeline() { return { events: [], cursor: null, cursor_ts: null }; }

  function byTime(a, b) { return (a.ts === null ? -1 : b.ts === null ? 1 : a.ts - b.ts); }

  // A refresh brought the newest page. Overlapping with what is loaded: add the new steps and refresh the
  // known ones (durations and links appear later), keeping the older cursor. No overlap (a lot happened, or
  // nothing was loaded): start over from this page.
  function mergeLatest(state, page) {
    var have = {};
    state.events.forEach(function (e) { have[e.key] = true; });
    var overlap = page.events.some(function (e) { return have[e.key]; });
    if (!state.events.length || !overlap) return { events: page.events.slice(), cursor: page.cursor, cursor_ts: page.cursor_ts };
    var fresh = {};
    page.events.forEach(function (e) { fresh[e.key] = e; });
    var kept = state.events.map(function (e) { return fresh[e.key] || e; });
    page.events.forEach(function (e) { if (!have[e.key]) kept.push(e); });
    kept.sort(byTime);
    return { events: kept, cursor: state.cursor, cursor_ts: state.cursor_ts };
  }

  function mergeOlder(state, page) {
    var have = {};
    state.events.forEach(function (e) { have[e.key] = true; });
    var older = page.events.filter(function (e) { return !have[e.key]; });
    return { events: older.concat(state.events), cursor: page.cursor, cursor_ts: page.cursor_ts };
  }

  // Display rows: each event with the time since the previous one and whether the day changed.
  function withGaps(events) {
    return events.map(function (e, i) {
      var prev = i ? events[i - 1] : null;
      var gap = prev && prev.ts !== null && e.ts !== null ? e.ts - prev.ts : null;
      var newDay = !prev || (prev.ts !== null && e.ts !== null && new Date(prev.ts).toDateString() !== new Date(e.ts).toDateString());
      return { ev: e, gap: gap, newDay: newDay };
    });
  }

  function kindCounts(events) {
    var c = {};
    events.forEach(function (e) { c[e.kind] = (c[e.kind] || 0) + 1; });
    return c;
  }

  // Text of a step. Private mode only removes; the server already left out what show_text does not allow.
  function stepText(ev, priv) {
    return { text: priv ? null : ev.text || null, target: priv ? null : ev.target || null, agentType: priv ? null : ev.agent_type || null };
  }

  // Does a step match the search text? Case-insensitive, every word must occur somewhere in the step's names
  // (kind, tool, crewgate event type, task id) or, unless private mode hides text, its prompt snippet, tool target
  // and subagent type. Private mode only removes fields, so it never makes a search find more.
  function stepMatches(ev, query, priv) {
    var words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    var st = stepText(ev, priv);
    var hay = [ev.kind, ev.tool, ev.type, ev.task, ev.phase === 'stop' ? 'finished stop' : ev.phase === 'start' ? 'started start' : '', st.text, st.target, st.agentType].filter(Boolean).join(' ').toLowerCase();
    return words.every(function (w) { return hay.indexOf(w) >= 0; });
  }

  // Only ids the server makes are used in links.
  function validId(id) { return typeof id === 'string' && /^[0-9a-f]{12}$/.test(id); }

  return { cleanFilter: cleanFilter, matches: matches, buildTree: buildTree, isOpen: isOpen, visible: visible, counts: counts, isRunning: isRunning, isWaiting: isWaiting, displayStatus: displayStatus, fmtDuration: fmtDuration, compact: compact, tokenSum: tokenSum, cardStats: cardStats, KIND_ORDER: KIND_ORDER, emptyTimeline: emptyTimeline, mergeLatest: mergeLatest, mergeOlder: mergeOlder, withGaps: withGaps, kindCounts: kindCounts, stepText: stepText, stepMatches: stepMatches, validId: validId, STATES: STATES, ENGINES: ENGINES };
}));
