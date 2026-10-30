(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlanModel = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Pure helpers for the plan page (no DOM): state marks, the growth view and the private-mode rule.
  // app.js renders what these return.

  var DAY = 24 * 60 * 60 * 1000;
  // Every state has a glyph and a word, so colour is never the only signal.
  var MARKS = {
    todo: '○', doing: '▶', review: '◎', done: '✓', blocked: '!', dropped: '–', proposed: '?'
  };
  var GROWTH_DAYS = 7;

  function mark(state) { return Object.prototype.hasOwnProperty.call(MARKS, state) ? MARKS[state] : '○'; }

  function flatten(nodes) {
    var out = [];
    (function walk(list) { (list || []).forEach(function (n) { out.push(n); walk(n.children); }); }(nodes));
    return out;
  }

  // Private mode shows ids and states only: the text becomes the node id.
  function nodeText(n, mask) { return mask ? n.id : n.text; }
  function planTitle(p, mask) { return mask ? p.slug : (p.title || p.slug); }

  function dayStart(ms) { var d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
  function dateMs(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : NaN;
  }

  // Added within the last `days` days (today counts as day 0).
  function isRecent(added, now, days) {
    var ms = dateMs(added);
    if (isNaN(ms)) return false;
    var age = Math.round((dayStart(now) - ms) / DAY);
    return age >= 0 && age < (days || GROWTH_DAYS);
  }

  // Additions grouped by day (newest first), then by origin: [{ date, origins: [{ origin, items: [node] }] }].
  // Nodes without an added date are left out.
  function growth(nodes, now, days) {
    var byDate = {};
    flatten(nodes).forEach(function (n) {
      if (isNaN(dateMs(n.added))) return;
      var day = byDate[n.added] || (byDate[n.added] = {});
      (day[n.origin] || (day[n.origin] = [])).push(n);
    });
    var groups = Object.keys(byDate).sort().reverse().map(function (date) {
      return {
        date: date,
        recent: isRecent(date, now, days),
        origins: Object.keys(byDate[date]).sort().map(function (o) { return { origin: o, items: byDate[date][o] }; })
      };
    });
    var recent = {};
    flatten(nodes).forEach(function (n) { if (isRecent(n.added, now, days)) recent[n.id] = true; });
    return { groups: groups, recent: recent, recentCount: Object.keys(recent).length };
  }

  // Collapsed nodes are kept in the browser: only keys of the right shape count.
  function collapseKey(project, slug, id) { return project + '/' + slug + '/' + id; }
  function cleanCollapsed(o) {
    var out = {};
    if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
    Object.keys(o).slice(0, 2000).forEach(function (k) { if (/^[\w.-]{1,64}\/[a-z0-9-]{1,40}\/[\w.-]{1,24}$/.test(k) && o[k] === true) out[k] = true; });
    return out;
  }

  // Proposals waiting for a decision, as the server sends them (plan review). Private mode shows the id
  // where a text would be; the commands and the kind/action words are not text and stay.
  function proposalText(p, mask) { return mask ? p.id : p.text; }
  function targetText(p, mask) { return !p.target ? '' : (mask || !p.target.text ? p.target.id : p.target.text); }
  function pending(d) { return d && Array.isArray(d.proposals) ? d.proposals : []; }
  // Round history, newest first.
  function rounds(d) { return (d && Array.isArray(d.rounds) ? d.rounds.slice() : []).sort(function (a, b) { return b.round - a.round; }); }
  function pendingTotal(list) { return (list || []).reduce(function (s, p) { return s + (p.pending || 0); }, 0); }

  // A link may only point at a task id the server made.
  function validTask(id) { return typeof id === 'string' && /^[\w.-]{1,40}$/.test(id); }

  return { MARKS: MARKS, GROWTH_DAYS: GROWTH_DAYS, mark: mark, flatten: flatten, nodeText: nodeText, planTitle: planTitle, isRecent: isRecent, growth: growth, collapseKey: collapseKey, cleanCollapsed: cleanCollapsed, validTask: validTask, proposalText: proposalText, targetText: targetText, pending: pending, rounds: rounds, pendingTotal: pendingTotal };
}));
