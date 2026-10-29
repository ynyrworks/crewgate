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

  return { cleanFilter: cleanFilter, matches: matches, buildTree: buildTree, isOpen: isOpen, visible: visible, counts: counts, isRunning: isRunning, isWaiting: isWaiting, displayStatus: displayStatus, STATES: STATES, ENGINES: ENGINES };
}));
