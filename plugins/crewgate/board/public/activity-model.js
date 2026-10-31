(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ActivityModel = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Pure helpers for the project page cards (no DOM): which form a card takes and what an activity row says.
  // `d` is the answer of GET /api/project/:id, `t(key, vars)` the translator, `mask` private mode (ids only).

  function isMerge(a) { return a.type === 'task.merged' || a.type === 'git.push'; }
  function mergeActs(list) { return (list || []).filter(isMerge).slice(0, 10); }
  function stepActs(list) { return (list || []).filter(function (a) { return !isMerge(a); }).slice(0, 15); }

  function validationRows(v) {
    var n = 0;
    Object.keys(v || {}).forEach(function (k) { n += (v[k] || []).length; });
    return n;
  }

  // Stored data always wins; events fill only an empty log or merge card; validation never reads events.
  //   work: 'card' | 'fold'   log: 'log' | 'acts' | 'fold'   mrs: 'mrs' | 'merges' | 'none'   validation: 'card' | 'fold'
  function forms(d) {
    var workItems = 0;
    (d.work || []).forEach(function (s) { workItems += s.items.length; });
    return {
      work: (d.work || []).length ? 'card' : 'fold',
      log: (d.log || []).length ? 'log' : stepActs(d.activity).length ? 'acts' : 'fold',
      mrs: (d.mrs || []).length ? 'mrs' : mergeActs(d.activity).length ? 'merges' : 'none',
      validation: validationRows(d.validation) ? 'card' : 'fold',
      workItems: workItems,
    };
  }

  function who(a, mask) { return a.task ? (mask ? a.task : (a.title || a.task)) : ''; }

  // Row of the log card: "who . what"
  function rowText(a, mask, t) {
    var x = a.data || {};
    var txt = a.type === 'gate.answered' ? t('act.gate', { gate: x.gate || '', answer: x.answer || '' }) : a.type === 'plan.created' ? t('act.plan') : t('act.' + a.type);
    var w = who(a, mask);
    if (w) return w + ' \u00b7 ' + txt;
    return a.type === 'plan.created' && x.slug && !mask ? txt + ' \u00b7 ' + x.slug : txt;
  }

  // Row of the recent merges card, after the time and the name: what happened, branch, commit, remote, refs
  function detailText(a, mask, t) {
    var x = a.data || {}, bits = [];
    bits.push(a.type === 'task.merged' ? t('act.merged') : t('act.push'));
    if (!mask) {
      if (a.type === 'task.merged') { if (x.branch) bits.push(x.branch); if (x.note) bits.push(x.note); }
      else if (Array.isArray(x.refs) && x.refs.length) { if (x.remote) bits.push(x.remote); bits.push(x.refs.join(', ')); }
      else { if (x.remote) bits.push(x.remote); if (x.head) bits.push(x.head); }
    }
    return (who(a, mask) ? ' \u00b7 ' : '') + bits.join(' \u00b7 ');
  }

  return { mergeActs: mergeActs, stepActs: stepActs, forms: forms, who: who, rowText: rowText, detailText: detailText };
}));
