(function () {
  'use strict';

  // ------------------------------------------------------------------ state and helpers
  var $ = function (id) { return document.getElementById(id); };
  var TOKEN = (document.querySelector('meta[name="crew-token"]') || {}).content || '';
  var S = { lang: 'en', mask: false, sf: null, sopen: {}, tables: {}, meta: null, timer: null, last: '', route: null, busy: false, offline: false };

  function store(key, val) {
    try { if (val === undefined) return window.localStorage.getItem(key); window.localStorage.setItem(key, val); } catch (e) { /* storage unavailable */ }
    return null;
  }

  // t(key, vars): current language, then English, then the key
  function t(key, vars) {
    var s = (S.tables[S.lang] || {})[key];
    if (s === undefined) s = (S.tables.en || {})[key];
    if (s === undefined) return key;
    return vars ? s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] === undefined ? m : String(vars[k]); }) : s;
  }

  // h(tag, attrs, ...children): DOM builder. Text is always a text node, never markup.
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }

  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', headers: { 'X-Crew-Lang': S.lang }, cache: 'no-store' };
    if (opts.body !== undefined) {
      init.method = 'POST';
      init.headers['Content-Type'] = 'application/json';
      init.headers['X-Crew-Token'] = TOKEN;
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: { message: 'HTTP ' + r.status } }; }).then(function (d) {
        setOffline(false);
        return { status: r.status, data: d };
      });
    }, function (e) { setOffline(true); throw e; });
  }

  function setOffline(v) {
    S.offline = v;
    var el = $('offline');
    el.hidden = !v;
    el.textContent = v ? t('offline') : '';
  }

  var NF = function () { return new Intl.NumberFormat(S.lang); };
  function num(n) { return NF().format(n || 0); }
  function money(n) { return n === null || n === undefined ? '–' : '$' + new Intl.NumberFormat(S.lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n); }
  function ago(iso) {
    if (!iso) return '–';
    var ms = Date.parse(iso);
    if (isNaN(ms)) return '–';
    var s = Math.round((ms - Date.now()) / 1000);
    var rf = new Intl.RelativeTimeFormat(S.lang, { numeric: 'auto' });
    var a = Math.abs(s);
    if (a < 60) return rf.format(Math.round(s), 'second');
    if (a < 3600) return rf.format(Math.round(s / 60), 'minute');
    if (a < 86400) return rf.format(Math.round(s / 3600), 'hour');
    return rf.format(Math.round(s / 86400), 'day');
  }
  function when(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString(S.lang);
  }

  // Project names can be hidden for screen sharing: stable alias from the id.
  var aliasCache = {};
  function pname(p) {
    if (!S.mask) return p.name;
    var id = p.id || p;
    if (!aliasCache[id]) aliasCache[id] = t('project') + ' ' + (Object.keys(aliasCache).length + 1);
    return aliasCache[id];
  }

  function badge(kind, label) { return h('span', { class: 'badge s-' + kind, text: label === undefined ? t('state.' + kind) : label }); }
  function empty(key) { return h('p', { class: 'empty', text: t(key) }); }
  function card(title, body, extra) { return h('section', { class: 'card' + (extra ? ' ' + extra : '') }, h('h2', { text: title }), body); }
  function table(head, rows, numCols) {
    numCols = numCols || [];
    return h('div', { class: 'scroll' }, h('table', null,
      h('thead', null, h('tr', null, head.map(function (c, i) { return h('th', { scope: 'col', class: numCols.indexOf(i) >= 0 ? 'num' : '', text: c }); }))),
      h('tbody', null, rows)));
  }
  function td(content, num) { return h('td', { class: num ? 'num' : '' }, content); }

  // ------------------------------------------------------------------ update banner
  // The server does the check and the update (DESIGN section 10); this only shows the state and asks.
  // S.upd: { info, phase: idle|running|restarting|manual|failed|done, status, oldVersion, since, doneVersion }
  var UM = window.UpdateModel;
  var UPD_LIMIT = 45000;
  S.upd = { info: null, phase: 'idle', status: null, oldVersion: '', since: 0, doneVersion: '' };

  function loadUpdate() {
    if (S.upd.phase !== 'idle') return;
    api('/api/update').then(function (r) { if (r.status < 400) { S.upd.info = r.data; renderUpdate(); } }).catch(function () { /* offline banner shows */ });
  }

  function copyText(text, done) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { /* select by hand */ });
    } catch (e) { /* clipboard unavailable: the commands stay visible */ }
  }

  function commandBlock(lines) {
    var text = lines.join('\n');
    return [
      h('pre', { tabindex: '0', text: text }),
      h('button', { type: 'button', onclick: function (e) { var b = e.target; copyText(text, function () { b.textContent = t('update.copied'); }); }, text: t('update.copy') }),
    ];
  }

  function dismissBtn(then) {
    return h('span', { class: 'btns' }, h('button', { type: 'button', onclick: function () { S.upd.phase = 'idle'; renderUpdate(); if (then) then(); }, text: t('update.dismiss') }));
  }

  function renderUpdate() {
    var el = $('update');
    var u = S.upd;
    var info = u.info;
    var line = null;
    var extra = [];
    var fail = false;
    // the page refreshes every few seconds: rebuild only when something shown has changed (keeps focus and clicks)
    var sig = JSON.stringify([S.lang, u.phase, info, u.status, u.doneVersion, store('crew.skipUpdate') || '']);
    if (el.getAttribute('data-sig') === sig) return;
    el.setAttribute('data-sig', sig);
    el.setAttribute('aria-label', t('update.region'));
    if (u.phase === 'running') {
      var cur = u.status && u.status.current;
      line = [h('span', { class: 'msg', role: 'status', text: t('update.running') }), cur ? h('span', { class: 'muted', text: t('update.step', { cmd: cur }) }) : null];
    } else if (u.phase === 'restarting') {
      line = [h('span', { class: 'msg', role: 'status', text: t('update.restarting') })];
    } else if (u.phase === 'done') {
      line = [h('span', { class: 'msg', role: 'status', text: t('update.done', { version: u.doneVersion }) }), dismissBtn(loadUpdate)];
    } else if (u.phase === 'manual') {
      var cmds = [];
      ((u.status && u.status.manual) || []).forEach(function (g) { g.commands.forEach(function (c) { cmds.push(c); }); });
      cmds.push((u.status && u.status.restart_command) || 'crew board start');
      line = [h('span', { class: 'msg', text: t('update.manual') }), dismissBtn()];
      extra = commandBlock(cmds);
    } else if (u.phase === 'failed') {
      fail = true;
      var st = u.status || {};
      var bad = (st.steps || []).filter(function (x) { return !x.ok; })[0];
      line = [h('span', { class: 'msg', role: 'alert', text: t('update.failed') }), dismissBtn()];
      if (bad) extra = [h('p', { class: 'note', text: t('update.stepFailed', { cmd: bad.cmd }) }), h('pre', { tabindex: '0', text: bad.output || '' })];
      else extra = [h('p', { class: 'note', text: t('update.restartFailed') })].concat(commandBlock([st.restart_command || 'crew board start']));
    } else if (UM.visible(info, store('crew.skipUpdate') || '')) {
      line = [
        h('span', { class: 'msg', role: 'status', text: t('update.available', { latest: info.latest, kind: t(UM.kindKey(info.kind)) }) }),
        h('a', { href: info.notes_url, target: '_blank', rel: 'noopener noreferrer', text: t('update.notes') }),
        h('span', { class: 'btns' },
          h('button', { type: 'button', class: 'primary', onclick: applyUpdate, text: t('update.now') }),
          h('button', { type: 'button', onclick: function () { store('crew.skipUpdate', info.latest); renderUpdate(); }, text: t('update.skip') })),
      ];
      if (info.rehook) extra = [h('p', { class: 'note', text: t('update.rehook') })];
    }
    el.textContent = '';
    el.className = fail ? 'update fail' : 'update';
    if (!line) { el.hidden = true; return; }
    el.hidden = false;
    el.appendChild(h('div', { class: 'line' }, line));
    extra.forEach(function (x) { el.appendChild(x); });
  }

  function applyUpdate() {
    var u = S.upd;
    u.oldVersion = (u.info && u.info.current) || '';
    u.phase = 'running';
    u.status = null;
    renderUpdate();
    api('/api/update/apply', { body: {} }).then(function (r) {
      if (r.status >= 400) {
        u.phase = 'failed';
        u.status = { steps: [{ ok: false, cmd: 'crew update', output: (r.data.error && r.data.error.message) || '' }] };
        renderUpdate();
        return;
      }
      pollUpdate();
    }).catch(function () { u.phase = 'idle'; renderUpdate(); });
  }

  function pollUpdate() {
    var u = S.upd;
    if (u.phase !== 'running' && u.phase !== 'restarting') return;
    var again = function () { setTimeout(pollUpdate, 1000); };
    var toRestart = function () { u.phase = 'restarting'; u.since = Date.now(); renderUpdate(); again(); };
    if (u.phase === 'restarting') {
      fetch('/api/health', { cache: 'no-store' }).then(function (r) { return r.json(); }).catch(function () { return null; }).then(function (hl) {
        var v = UM.restartVerdict(u.oldVersion, hl, Date.now() - u.since, UPD_LIMIT);
        if (v === 'ok') { store('crew.updated', hl.version); window.location.reload(); return; }
        if (v === 'timeout') { u.phase = 'failed'; u.status = { restart_command: 'crew board start', steps: [] }; renderUpdate(); return; }
        // the old board may be back already and say the restart failed
        fetch('/api/update/status', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
          if (d && d.state === 'failed') { u.phase = 'failed'; u.status = d; renderUpdate(); } else again();
        }).catch(again);
      });
      return;
    }
    api('/api/update/status').then(function (r) {
      var d = r.data;
      u.status = d;
      if (d.state === 'running') { renderUpdate(); again(); return; }
      if (d.state === 'restarting') { toRestart(); return; }
      if (d.state === 'manual') u.phase = 'manual';
      else if (d.state === 'failed') u.phase = 'failed';
      else if (d.state === 'done') { u.phase = 'done'; u.doneVersion = d.new_version || ''; } else u.phase = 'idle';
      renderUpdate();
    }).catch(toRestart);   // the board stopped answering: it is restarting itself
  }

  // Shown once, after the page reloaded onto the updated board.
  function showUpdated() {
    var v = store('crew.updated');
    if (!v) return;
    store('crew.updated', '');
    S.upd.phase = 'done';
    S.upd.doneVersion = v;
  }

  // ------------------------------------------------------------------ routing
  function parseRoute() { return parseHash(location.hash); }
  function parseHash(hash) {
    var p = (hash || '#/').replace(/^#/, '').split('/').filter(Boolean);
    if (!p.length) return { page: 'overview' };
    if (p[0] === 'p' && p[1]) return p[2] === 'settings' ? { page: 'psettings', id: p[1] } : { page: 'project', id: p[1] };
    if (p[0] === 's' && p[1]) return { page: 'session', id: p[1] };
    if (['sessions', 'office', 'usage', 'settings'].indexOf(p[0]) >= 0) return { page: p[0] };
    return { page: 'overview' };
  }

  function renderChrome() {
    document.documentElement.lang = S.lang;
    document.title = 'crewgate – ' + t('title');
    $('skip').textContent = t('skip');
    $('nav').setAttribute('aria-label', t('nav'));
    var page = S.route.page;
    var items = [['overview', '#/', t('nav.overview')], ['sessions', '#/sessions', t('nav.sessions')], ['office', '#/office', t('office.nav')], ['usage', '#/usage', t('nav.usage')], ['settings', '#/settings', t('nav.settings')]];
    var nav = $('nav');
    nav.textContent = '';
    items.forEach(function (it) {
      var cur = it[0] === page || (it[0] === 'overview' && (page === 'project' || page === 'psettings')) || (it[0] === 'sessions' && page === 'session');
      nav.appendChild(h('a', { href: it[1], 'aria-current': cur ? 'page' : false, text: it[2] }));
    });
    var tools = $('tools');
    tools.textContent = '';
    var sel = h('select', { id: 'lang', 'aria-label': t('language'), onchange: function (e) { setLang(e.target.value); } },
      h('option', { value: 'en', selected: S.lang === 'en', text: 'English' }),
      h('option', { value: 'zh-TW', selected: S.lang === 'zh-TW', text: '繁體中文' }));
    var mask = h('input', { type: 'checkbox', id: 'mask', role: 'switch', checked: S.mask, onchange: function (e) { S.mask = e.target.checked; store('crew.mask', S.mask ? '1' : '0'); refresh(true); } });
    tools.appendChild(h('label', { title: t('maskHint'), class: 'switch' }, mask, t('mask')));
    tools.appendChild(sel);
    renderUpdate();
  }

  function setLang(lang) {
    S.lang = lang === 'zh-TW' ? 'zh-TW' : 'en';
    store('crew.lang', S.lang);
    loadTables().then(function () { renderChrome(); refresh(true); });
  }

  function loadTables() {
    var need = ['en'];
    if (S.lang !== 'en') need.push(S.lang);
    return Promise.all(need.map(function (l) {
      if (S.tables[l]) return null;
      return fetch('/i18n/' + l + '.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) { S.tables[l] = d; }).catch(function () { S.tables[l] = {}; });
    }));
  }

  // ------------------------------------------------------------------ pages
  var TASK_ORDER = ['dispatched', 'returned', 'reviewing', 'created', 'accepted', 'merged', 'cancelled'];

  function overviewPage(d) {
    var root = h('div', null, h('h1', { text: t('nav.overview') }));
    if (!d.projects.length) return root.appendChild(h('div', { class: 'card' }, empty('overview.none'), h('code', { text: 'crew project add' }))), root;
    var list = h('div', { class: 'card', role: 'table', 'aria-label': t('nav.overview') });
    list.appendChild(h('div', { class: 'proj head', role: 'row' }, ['project', 'overview.tasks', 'overview.needs', 'overview.subagents', 'overview.sessions', 'overview.last'].map(function (k) { return h('span', { role: 'columnheader', text: t(k) }); })));
    d.projects.forEach(function (p) {
      var chips = TASK_ORDER.filter(function (s) { return p.tasks[s]; }).map(function (s) { return badge(s, t('state.' + s) + ' ' + p.tasks[s]); });
      list.appendChild(h('a', { class: 'proj', role: 'row', href: '#/p/' + p.id },
        h('span', { class: 'name', role: 'cell' }, pname(p), p.config_errors ? h('span', { class: 'err', title: t('config.errors') }, ' !') : null),
        h('span', { role: 'cell' }, chips.length ? h('span', null, chips.map(function (c) { return [c, ' ']; })) : h('span', { class: 'muted', text: '–' })),
        h('span', { role: 'cell', class: p.needs ? 'needs-on' : '', text: String(p.needs) }),
        h('span', { role: 'cell', text: String(p.live.subagents) }),
        h('span', { role: 'cell', text: String(p.live.sessions) }),
        h('span', { role: 'cell', text: ago(p.last_activity) })));
    });
    root.appendChild(list);
    return root;
  }

  function reviewText(r) {
    if (!r || !r.rounds) return '–';
    return t('review.summary', { rounds: r.rounds, final: r.final, dropped: r.filtered });
  }

  function formRow(fields, label, onSubmit) {
    var form = h('form', { class: 'row', onsubmit: function (e) { e.preventDefault(); onSubmit(form); } });
    fields.forEach(function (f) { form.appendChild(f); });
    form.appendChild(h('button', { type: 'submit', text: label }));
    return form;
  }
  function post(path, body, done) {
    api(path, { body: body }).then(function (r) {
      if (r.status >= 400) { window.alert((r.data.error && r.data.error.message) || 'Error'); return; }
      if (done) done(r.data);
      refresh(true);
    }).catch(function () { /* offline banner already shown */ });
  }

  function projectPage(d) {
    var id = d.project.id;
    var root = h('div', null,
      h('h1', { text: pname(d.project) }),
      h('p', { class: 'muted' }, t('project.last') + ': ' + ago(d.last_activity) + ' · ', h('a', { href: '#/p/' + id + '/settings', text: t('nav.settings') })));
    if (d.config_errors.length) {
      root.appendChild(card(t('config.errors'), h('ul', { class: 'list' }, d.config_errors.map(function (e) { return h('li', { class: 'err', text: e.path + ': ' + e.message }); })), 'alert'));
    }
    // needs
    var needBody = h('div', null);
    if (d.needs.open.length) {
      needBody.appendChild(h('ul', { class: 'list' }, d.needs.open.map(function (n) {
        return h('li', null, '#' + n.id + ' ' + n.text + ' ', h('button', { class: 'link', text: t('need.done'), onclick: function () { post('/api/project/' + id + '/need/done', { id: n.id }); } }));
      })));
    } else needBody.appendChild(empty('need.none'));
    needBody.appendChild(formRow([h('input', { type: 'text', name: 'text', required: true, 'aria-label': t('need.add'), placeholder: t('need.add'), size: 30 })], t('add'),
      function (f) { post('/api/project/' + id + '/need', { text: f.elements.text.value }, function () { f.reset(); }); }));
    root.appendChild(card(t('project.needs'), needBody, d.needs.open.length ? 'alert' : ''));

    // tasks
    var rows = d.tasks.slice().sort(function (a, b) { return TASK_ORDER.indexOf(a.state) - TASK_ORDER.indexOf(b.state); }).map(function (tk) {
      return h('tr', null,
        td(h('details', null, h('summary', { text: tk.title || tk.id }),
          h('ul', { class: 'list' }, tk.history.map(function (x) { return h('li', { class: 'muted', text: when(x.ts) + ' · ' + x.state + (x.note ? ' · ' + x.note : '') }); })),
          h('code', { text: tk.id }))),
        td(badge(tk.state)), td(String(tk.returns), true), td(tk.role || ''), td(reviewText(tk.review)), td(ago(tk.updated)));
    });
    root.appendChild(card(t('project.tasks'), d.tasks.length
      ? table([t('task.title'), t('task.state'), t('task.returns'), t('task.role'), t('task.review'), t('task.updated')], rows, [2]) : empty('task.none')));

    var grid = h('div', { class: 'grid' });
    // live sessions
    grid.appendChild(card(t('project.sessions'), d.sessions.length ? sessionTree(d.sessions, false, null) : empty('sessions.none')));
    // work
    var workBody = h('div', null);
    if (!d.work.length) workBody.appendChild(empty('work.none'));
    d.work.forEach(function (s) {
      workBody.appendChild(h('h3', { text: s.name }));
      workBody.appendChild(h('ul', { class: 'list' }, s.items.map(function (it) {
        return h('li', null, badge(it.state), ' ' + it.title + (it.note ? ' – ' + it.note : '') + ' ',
          h('button', { class: 'link', text: t('remove'), onclick: function () { post('/api/project/' + id + '/work/rm', { stream: s.name, title: it.title }); } }));
      })));
    });
    workBody.appendChild(formRow([
      h('input', { type: 'text', name: 'stream', required: true, placeholder: t('work.stream'), 'aria-label': t('work.stream'), size: 10 }),
      h('input', { type: 'text', name: 'title', required: true, placeholder: t('work.item'), 'aria-label': t('work.item'), size: 16 }),
      h('select', { name: 'state', 'aria-label': t('task.state') }, ['todo', 'doing', 'done', 'waiting', 'parked'].map(function (s) { return h('option', { value: s, text: t('state.' + s) }); })),
    ], t('add'), function (f) { post('/api/project/' + id + '/work', { stream: f.elements.stream.value, title: f.elements.title.value, state: f.elements.state.value }, function () { f.reset(); }); }));
    grid.appendChild(card(t('project.work'), workBody));
    // log
    var logBody = h('div', null, d.log.length ? h('ul', { class: 'list' }, d.log.slice(0, 15).map(function (l) { return h('li', null, h('span', { class: 'muted', text: ago(l.time) + ' · ' + l.who + ' · ' }), l.text); })) : empty('log.none'));
    logBody.appendChild(formRow([h('input', { type: 'text', name: 'text', required: true, placeholder: t('log.add'), 'aria-label': t('log.add'), size: 30 })], t('add'),
      function (f) { post('/api/project/' + id + '/log', { who: 'board', text: f.elements.text.value }, function () { f.reset(); }); }));
    grid.appendChild(card(t('project.log'), logBody));
    // merge requests and validation
    grid.appendChild(card(t('project.mrs'), d.mrs.length
      ? table(['!', t('task.title'), 'CI', t('mr.merged')], d.mrs.map(function (m) { return h('tr', null, td('!' + m.iid), td(m.title), td(m.ci ? badge(m.ci, m.ci) : ''), td(m.merged ? t('yes') : t('no'))); })) : empty('mr.none')));
    var vrows = [];
    Object.keys(d.validation).forEach(function (k) { (d.validation[k] || []).forEach(function (r) { vrows.push(h('tr', null, td(k), td(r.date), td(r.host), td(r.result))); }); });
    grid.appendChild(card(t('project.validation'), vrows.length ? table([t('validation.id'), t('validation.date'), t('validation.host'), t('validation.result')], vrows) : empty('validation.none')));
    // handoffs
    var hitems = [];
    ['open', 'accepted', 'cancelled'].forEach(function (st) {
      (d.handoffs[st] || []).forEach(function (x) {
        hitems.push(h('li', null, badge(st === 'open' ? 'waiting' : st, t('handoff.' + st)), ' ' + (x.title || x.id) + (x.task ? ' · ' + x.task : '')));
      });
    });
    grid.appendChild(card(t('project.handoffs'), hitems.length ? h('ul', { class: 'list' }, hitems) : empty('handoff.none')));
    // lessons
    var L = d.lessons;
    var lb = h('div', null);
    if (!L.exists || !L.total) lb.appendChild(empty('lessons.none'));
    else {
      lb.appendChild(h('p', { class: 'muted', text: t('lessons.summary', { total: L.total, keys: L.keys.length, candidates: L.candidates }) }));
      lb.appendChild(table([t('lessons.key'), t('lessons.count'), t('lessons.days'), t('lessons.last'), ''], L.keys.slice(0, 12).map(function (k) {
        return h('tr', null, td(k.key), td(String(k.count), true), td(String(k.days), true), td(k.last), td(k.candidate ? badge('waiting', t('lessons.candidate')) : ''));
      }), [1, 2]));
    }
    grid.appendChild(card(t('project.lessons'), lb));
    root.appendChild(grid);
    // events
    root.appendChild(card(t('project.events'), d.events.length
      ? h('div', { class: 'scroll' }, h('ul', { class: 'list' }, d.events.slice(0, 25).map(function (e) { return h('li', null, h('span', { class: 'muted', text: ago(e.ts) + ' · ' }), h('code', { text: e.type }), e.task ? ' ' + e.task : ''); })))
      : empty('events.none')));
    return root;
  }

  // ------------------------------------------------------------------ sessions
  var SM = window.SessionsModel;

  function sessionFilter() { return SM.cleanFilter(S.sf); }
  function saveFilter(f) {
    S.sf = SM.cleanFilter(f);
    store('crew.sessionFilter', JSON.stringify(S.sf));
  }
  function saveOpen() { store('crew.sessionOpen', JSON.stringify(S.sopen)); }

  var GLYPH = { working: '▶', tool: '⚙', waiting: '!', idle: '–', done: '✓' };
  function chip(status) {
    return h('span', { class: 'badge chip s-' + status }, h('span', { class: 'glyph', 'aria-hidden': 'true', text: GLYPH[status] || '' }), t('state.' + status));
  }

  function activityText(r, v, shown) {
    var a = r.activity || { kind: r.status };
    var kind = ['thinking', 'tool', 'writing', 'waiting', 'idle', 'done'].indexOf(a.kind) >= 0 ? a.kind : 'thinking';
    if (shown === 'done' && kind === 'waiting') kind = 'done';
    if (kind === 'tool') return a.tool ? t('act.tool', { tool: a.tool }) + (v.target ? ' · ' + v.target : '') : t('act.toolPlain');
    return t('act.' + kind);
  }

  var ROLES = ['orchestrator', 'worker', 'reviewer', 'refuter', 'other'];

  function sessionItem(n, withProject) {
    var r = n.row;
    var v = SM.visible(r, S.mask);
    var open = SM.isOpen(n, S.sopen);
    var head = h('div', { class: 's-head' });
    if (n.children.length) {
      head.appendChild(h('button', {
        class: 'toggle', type: 'button', 'aria-expanded': open ? 'true' : 'false',
        'aria-label': t('sessions.children', { count: n.children.length }),
        onclick: function () { S.sopen[r.id] = !open; saveOpen(); S.last = ''; refresh(true); }
      }, open ? '▾' : '▸'));
    }
    var shown = SM.displayStatus(r);
    head.appendChild(chip(shown));
    var act = activityText(r, v, shown);
    if (act !== t('state.' + shown) && act !== t('act.' + shown)) head.appendChild(h('span', { class: 's-act', text: act }));
    if (r.role) head.appendChild(h('span', { class: 'role r-' + r.role, text: t('role.' + (ROLES.indexOf(r.role) >= 0 ? r.role : 'other')) }));
    if (n.children.length) head.appendChild(h('span', { class: 'muted', text: t('sessions.running', { running: n.running, count: n.children.length }) }));
    head.appendChild(h('a', { class: 's-link', href: '#/s/' + r.id, text: t('stats.open'), 'aria-label': t('stats.openFor', { name: (r.engine === 'codex' ? 'Codex' : 'Claude') + (r.model ? ' ' + r.model : '') }) }));
    head.appendChild(h('span', { class: 's-time muted', text: ago(r.lastActivity) }));

    var meta = [r.engine === 'codex' ? 'Codex' : 'Claude'];
    if (r.model) meta.push(r.model);
    if (r.subagent) meta.push(r.agent_type && !S.mask ? r.agent_type : t('sessions.subagent'));
    if (withProject && r.project) meta.push(pname({ id: r.project, name: r.project_name || r.project }));
    var where = [];
    if (v.folder) where.push(v.folder);
    if (v.branch) where.push((r.detached ? t('sessions.detached') + ' ' : '') + v.branch);
    if (v.worktree) where.push(t('sessions.worktree', { name: v.worktree }));
    var li = h('li', { class: 'sess' + (SM.isWaiting(r) ? ' is-waiting' : '') + (r.subagent ? ' is-sub' : '') },
      head,
      h('div', { class: 's-meta muted', text: meta.join(' · ') }));
    var sl = statsLine(r);
    if (sl) li.appendChild(sl);
    if (where.length) li.appendChild(h('div', { class: 's-where', text: where.join(' · ') }));
    if (r.task) li.appendChild(h('div', { class: 's-task' }, h('span', { class: 'task-id', text: r.task.id }), v.taskTitle ? ' ' + v.taskTitle : ''));
    if (v.title) li.appendChild(h('div', { class: 's-title', text: v.title }));
    if (v.prompt) li.appendChild(h('div', { class: 's-snip' }, h('span', { class: 'muted', text: t('sessions.prompt') + ' ' }), v.prompt));
    if (v.reply) li.appendChild(h('div', { class: 's-snip' }, h('span', { class: 'muted', text: t('sessions.reply') + ' ' }), v.reply));
    if (n.children.length && open) {
      li.appendChild(h('ul', { class: 'stree sub' }, n.children.map(function (c) { return sessionItem(c, withProject); })));
    }
    return li;
  }

  function sessionTree(rows, withProject, filter) {
    var tree = SM.buildTree(rows, filter);
    if (!tree.length) return empty('sessions.noMatch');
    return h('ul', { class: 'stree' }, tree.map(function (n) { return sessionItem(n, withProject); }));
  }

  function filterBar(rows) {
    var f = sessionFilter();
    var projects = {};
    rows.forEach(function (r) { if (r.project) projects[r.project] = r.project_name || r.project; });
    var apply = function (key) {
      return function (e) {
        var nf = sessionFilter();
        nf[key] = e.target.value;
        saveFilter(nf);
        e.target.blur();   // a focused select would keep the page from re-rendering
        S.last = '';
        refresh(true);
      };
    };
    var sel = function (label, key, opts) {
      return h('label', { class: 'fl' }, h('span', { class: 'muted', text: label }),
        h('select', { 'aria-label': label, onchange: apply(key) }, opts.map(function (o) { return h('option', { value: o[0], selected: f[key] === o[0], text: o[1] }); })));
    };
    var popts = [['', t('sessions.allProjects')]];
    Object.keys(projects).forEach(function (id) { popts.push([id, pname({ id: id, name: projects[id] })]); });
    popts.push(['-', t('sessions.noProject')]);
    return h('div', { class: 'filters', role: 'group', 'aria-label': t('sessions.filters') },
      sel(t('sessions.project'), 'project', popts),
      sel(t('sessions.state'), 'state', [['all', t('sessions.fAll')], ['running', t('sessions.fRunning')], ['waiting', t('state.waiting')]]),
      sel(t('sessions.engine'), 'engine', [['all', t('sessions.fAll')], ['claude', 'Claude'], ['codex', 'Codex']]));
  }

  function sessionsPage(d) {
    var counts = {};
    d.sessions.forEach(function (s) { var k = SM.displayStatus(s); counts[k] = (counts[k] || 0) + 1; });
    var kp = h('div', { class: 'kpis' }, ['working', 'tool', 'waiting', 'idle', 'done'].map(function (s) {
      return h('div', { class: 'kpi' }, h('div', { class: 'big', text: String(counts[s] || 0) }), h('div', { class: 'label', text: t('state.' + s) }));
    }));
    var note = S.mask ? t('sessions.textPrivate') : d.show_text ? t('sessions.textOn') : t('sessions.textOff');
    return h('div', null, h('h1', { text: t('nav.sessions') }), kp, d.sessions.length ? filterBar(d.sessions) : null,
      h('div', { class: 'card' }, d.sessions.length ? sessionTree(d.sessions, true, S.sf) : empty('sessions.none')),
      h('p', { class: 'muted', text: note }));
  }

  // ------------------------------------------------------------------ session statistics and detail (#/s/<id>)
  function plural(base, n) { return t(n === 1 ? base + '1' : base, { count: num(n) }); }
  function costText(cost, complete) { return cost === null || cost === undefined ? '–' : (cost > 0 && cost < 0.01 ? '<$0.01' : (complete === false ? '≥' : '') + money(cost)); }

  // The compact line on a session card: duration · prompts · tool calls · tokens · cost. A parent shows the totals
  // of itself plus its subagents. Numbers only, so private mode and board.show_text do not matter here.
  function statsLine(r) {
    var c = SM.cardStats(r);
    if (!c) return null;
    var parts = [SM.fmtDuration(c.duration)];
    if (c.prompts) parts.push(plural('stats.linePrompts', c.prompts));
    if (c.tools) parts.push(plural('stats.lineTools', c.tools));
    if (c.tokens) parts.push(t('stats.lineTokens', { count: SM.compact(c.tokens) }));
    if (c.cost !== null) parts.push(costText(c.cost, c.costComplete));
    var text = parts.join(' · ') + (c.partial ? ' …' : '');
    var tools = (r.totals || r.stats).tools || {};
    var tip = Object.keys(tools).sort(function (a, b) { return tools[b] - tools[a]; }).map(function (k) { return k + ' ' + tools[k]; }).join(', ');
    var el = h('div', { class: 's-stats', title: tip || false }, h('span', { text: text }));
    if (c.sessions > 1) el.appendChild(h('span', { class: 'muted', text: ' · ' + t('stats.withSub', { count: c.sessions - 1 }) }));
    if (c.partial) el.appendChild(h('span', { class: 'sr-only', text: ' ' + t('stats.partial') }));
    return el;
  }

  var DET = { id: null, kinds: [], tl: null, data: null, loading: false, focusKey: null };
  function detReset(id) { DET = { id: id, kinds: [], tl: SM.emptyTimeline(), data: null, loading: false, focusKey: null }; }
  function detQuery(extra) {
    var q = [];
    if (DET.kinds.length) q.push('kinds=' + DET.kinds.join(','));
    Object.keys(extra || {}).forEach(function (k) { if (extra[k] !== null && extra[k] !== undefined) q.push(k + '=' + encodeURIComponent(extra[k])); });
    return q.length ? '?' + q.join('&') : '';
  }

  // Redraw the detail page and keep keyboard focus on the same control (or on the step that was first before "load older").
  function detDraw() {
    var fid = DET.focusKey ? 'ev-' + DET.focusKey : document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-fid') : null;
    DET.focusKey = null;
    S.last = '';
    render(sessionDetailPage(), 'sd' + Date.now());
    if (fid) {
      var el = document.querySelector('[data-fid="' + fid + '"]');
      if (el) { try { el.focus(); } catch (e) { /* ignore */ } }
    }
  }

  function loadOlder() {
    var id = DET.id;
    if (DET.loading || !DET.tl || DET.tl.cursor === null) return;
    DET.loading = true;
    detDraw();
    api('/api/session/' + id + detQuery({ before: DET.tl.cursor, before_ts: DET.tl.cursor_ts, limit: 200 })).then(function (res) {
      if (DET.id !== id) return;
      DET.loading = false;
      if (res.status < 400) {
        DET.focusKey = DET.tl.events.length ? DET.tl.events[0].key : null;
        DET.tl = SM.mergeOlder(DET.tl, res.data);
      }
      detDraw();
    }).catch(function () { DET.loading = false; detDraw(); });
  }

  function setKinds(kinds) {
    DET.kinds = kinds;
    DET.tl = SM.emptyTimeline();
    DET.data = null;
    S.last = '';
    refresh(true);
  }

  function timeText(ms) { return new Date(ms).toLocaleTimeString(S.lang, { hour12: false }); }
  var KIND_KEY = { prompt: 'sessions.kindPrompt', tool: 'sessions.kindTool', subagent: 'sessions.kindSubagent', crew: 'sessions.kindCrew', error: 'sessions.kindError' };
  var EV_GLYPH = { prompt: '✎', tool: '⚙', subagent: '⧉', crew: '◆', error: '✖' };

  function stepItem(row) {
    var ev = row.ev;
    var st = SM.stepText(ev, S.mask);
    var li = h('li', { class: 'tl-item k-' + ev.kind + (ev.err || ev.kind === 'error' ? ' is-err' : ''), tabindex: '-1', 'data-fid': 'ev-' + ev.key });
    if (row.newDay && ev.ts !== null) li.appendChild(h('div', { class: 'tl-day', text: new Date(ev.ts).toLocaleDateString(S.lang) }));
    var head = h('div', { class: 'tl-head' });
    if (ev.ts !== null) head.appendChild(h('time', { class: 'tl-time', datetime: new Date(ev.ts).toISOString(), text: timeText(ev.ts) }));
    if (row.gap !== null && row.gap >= 1000) head.appendChild(h('span', { class: 'tl-gap muted', title: t('sessions.gapHint'), text: '+' + SM.fmtDuration(row.gap) }));
    head.appendChild(h('span', { class: 'tl-kind' }, h('span', { class: 'glyph', 'aria-hidden': 'true', text: EV_GLYPH[ev.kind] || '' }), t(KIND_KEY[ev.kind] || 'sessions.kindTool')));
    li.appendChild(head);
    var body = h('div', { class: 'tl-body' });
    if (ev.kind === 'prompt') {
      body.appendChild(st.text ? h('span', { class: 'tl-text', text: st.text }) : h('span', { class: 'muted', text: t('sessions.evPrompt') }));
    } else if (ev.kind === 'tool') {
      body.appendChild(h('strong', { text: ev.tool }));
      if (st.target) body.appendChild(h('code', { class: 'tl-target', text: st.target }));
      if (ev.err) body.appendChild(h('span', { class: 'badge s-failed', text: t('sessions.evFailed') }));
    } else if (ev.kind === 'subagent') {
      body.appendChild(h('strong', { text: ev.phase === 'stop' ? t('sessions.evSubStop') : t('sessions.evSubStart') }));
      if (st.agentType) body.appendChild(h('code', { class: 'tl-target', text: st.agentType }));
      if (ev.task) body.appendChild(h('span', { class: 'task-id', text: ev.task }));
    } else if (ev.kind === 'crew') {
      body.appendChild(h('code', { text: ev.type }));
      if (ev.task) body.appendChild(h('span', { class: 'task-id', text: ev.task }));
    } else {
      body.appendChild(h('strong', { text: t('sessions.evError') }));
      if (ev.tool) body.appendChild(h('code', { class: 'tl-target', text: ev.tool }));
    }
    if (ev.dur_ms !== undefined && ev.dur_ms >= 1000) body.appendChild(h('span', { class: 'muted', text: t('sessions.evTook', { d: SM.fmtDuration(ev.dur_ms) }) }));
    if (ev.kind === 'subagent' && SM.validId(ev.agent)) body.appendChild(h('a', { class: 's-link', href: '#/s/' + ev.agent, text: t('sessions.evOpen') }));
    li.appendChild(body);
    return li;
  }

  function statsCard(d) {
    var own = d.session.stats;
    if (!own) return null;
    var tot = d.session.totals || null;
    var rowOf = function (label, f) { var cells = [td(label), td(f(own), true)]; if (tot) cells.push(td(f(tot), true)); return h('tr', null, cells); };
    var head = ['', t('stats.own')];
    if (tot) head.push(t('stats.total', { count: tot.sessions - 1 }));
    var rows = [
      rowOf(t('stats.duration'), function (s) { return SM.fmtDuration(s.duration_ms); }),
      rowOf(t('stats.prompts'), function (s) { return num(s.prompts); }),
      rowOf(t('stats.toolCalls'), function (s) { return num(s.tool_calls); }),
      rowOf(t('stats.subagents'), function (s) { return num(s.subagents); }),
      rowOf(t('stats.errors'), function (s) { return num(s.errors); }),
      rowOf(t('stats.tokensIn'), function (s) { return num(s.tokens.input); }),
      rowOf(t('stats.tokensOut'), function (s) { return num(s.tokens.output); }),
      rowOf(t('stats.cacheWrite'), function (s) { return num(s.tokens.cache_write); }),
      rowOf(t('stats.cacheRead'), function (s) { return num(s.tokens.cache_read); }),
      rowOf(t('stats.cost'), function (s) { return costText(s.cost, s.cost_complete); })
    ];
    var body = h('div', null, h('div', { class: 'scroll' }, table(head, rows, tot ? [1, 2] : [1])));
    var tools = (tot || own).tools || {};
    var names = Object.keys(tools).sort(function (a, b) { return tools[b] - tools[a]; });
    if (names.length) {
      body.appendChild(h('h3', { text: t('stats.tools') }));
      body.appendChild(h('ul', { class: 'chips' }, names.map(function (k) { return h('li', { class: 'badge' }, k + ' ', h('b', { text: num(tools[k]) })); })));
    }
    var costs = own.cost === null && (!tot || tot.cost === null) ? t('stats.noPrices') : (own.cost_complete === false || (tot && tot.cost_complete === false)) ? t('stats.costPartial') : '';
    if (costs) body.appendChild(h('p', { class: 'muted', text: costs }));
    if (own.partial || (tot && tot.partial)) body.appendChild(h('p', { class: 'muted', role: 'status', text: t('stats.partial') }));
    return card(t('stats.title'), body);
  }

  function sessionDetailPage() {
    var d = DET.data;
    var s = d.session;
    var v = SM.visible(s, S.mask);
    var shown = SM.displayStatus(s);
    var title = (s.engine === 'codex' ? 'Codex' : 'Claude') + (s.model ? ' · ' + s.model : '');
    var meta = [];
    if (s.subagent) meta.push(s.agent_type && !S.mask ? s.agent_type : t('sessions.subagent'));
    if (s.project) meta.push(pname({ id: s.project, name: s.project_name || s.project }));
    if (v.folder) meta.push(v.folder);
    if (v.branch) meta.push((s.detached ? t('sessions.detached') + ' ' : '') + v.branch);
    if (v.worktree) meta.push(t('sessions.worktree', { name: v.worktree }));
    var top = h('div', { class: 's-head' }, chip(shown));
    if (s.role) top.appendChild(h('span', { class: 'role r-' + s.role, text: t('role.' + (ROLES.indexOf(s.role) >= 0 ? s.role : 'other')) }));
    top.appendChild(h('span', { class: 's-time muted', text: ago(s.lastActivity) }));
    var root = h('div', null,
      h('p', null, h('a', { href: '#/sessions', text: '← ' + t('sessions.back') })),
      h('h1', { text: title }), top, h('div', { class: 's-meta muted', text: meta.join(' · ') }));
    if (SM.validId(s.parent)) root.appendChild(h('p', null, h('a', { href: '#/s/' + s.parent, text: t('sessions.parent') })));
    if (s.task) root.appendChild(h('div', { class: 's-task' }, h('span', { class: 'task-id', text: s.task.id }), v.taskTitle ? ' ' + v.taskTitle : ''));
    var sc = statsCard(d);
    var kids = d.children || [];
    var kidBody = kids.length ? h('ul', { class: 'stree' }, kids.map(function (k) {
      var kv = SM.visible(k, S.mask);
      var li = h('li', { class: 'sess is-sub' },
        h('div', { class: 's-head' }, chip(SM.displayStatus(k)), k.role ? h('span', { class: 'role r-' + k.role, text: t('role.' + (ROLES.indexOf(k.role) >= 0 ? k.role : 'other')) }) : null,
          h('span', { class: 's-meta muted', text: k.agent_type && !S.mask ? k.agent_type : t('sessions.subagent') }),
          h('a', { class: 's-link', href: '#/s/' + k.id, text: t('stats.open') })));
      var line = statsLine(k);
      if (line) li.appendChild(line);
      if (kv.taskTitle) li.appendChild(h('div', { class: 's-task' }, kv.taskTitle));
      return li;
    })) : null;
    root.appendChild(h('div', { class: 'grid' }, sc, kidBody ? card(t('sessions.subagents'), kidBody) : null));

    // activity timeline
    var tl = DET.tl;
    var counts = SM.kindCounts(tl.events);
    var kinds = d.kinds || SM.KIND_ORDER;
    var bar = h('div', { class: 'filters kinds', role: 'group', 'aria-label': t('sessions.kinds') },
      h('button', { type: 'button', 'data-fid': 'k-all', 'aria-pressed': DET.kinds.length ? 'false' : 'true', onclick: function () { setKinds([]); }, text: t('sessions.fAll') }),
      kinds.map(function (k) {
        var on = DET.kinds.indexOf(k) >= 0;
        return h('button', {
          type: 'button', 'data-fid': 'k-' + k, 'aria-pressed': on ? 'true' : 'false',
          onclick: function () { setKinds(on ? DET.kinds.filter(function (x) { return x !== k; }) : DET.kinds.concat([k])); }
        }, t(KIND_KEY[k] || 'sessions.kindTool') + (counts[k] ? ' ' + counts[k] : ''));
      }));
    var more = tl.cursor !== null
      ? h('button', { type: 'button', class: 'older', 'data-fid': 'older', disabled: DET.loading, onclick: loadOlder, text: DET.loading ? t('sessions.loading') : t('sessions.loadOlder') })
      : h('p', { class: 'muted', text: t('sessions.startReached') });
    var list = tl.events.length
      ? h('ol', { class: 'tl', 'aria-label': t('sessions.timeline') }, SM.withGaps(tl.events).map(stepItem))
      : empty('sessions.noEvents');
    var note = S.mask ? t('sessions.textPrivate') : d.show_text ? t('sessions.textOn') : t('sessions.tlTextOff');
    root.appendChild(h('section', { class: 'card' }, h('h2', { text: t('sessions.timeline') }), h('p', { class: 'muted', text: note }), bar, more, list));
    return root;
  }

  var FAMS = ['opus', 'sonnet', 'haiku', 'openai', 'other'];
  function usagePage(d) {
    var root = h('div', null, h('h1', { text: t('nav.usage') }));
    root.appendChild(h('div', { class: 'kpis' },
      h('div', { class: 'kpi' }, h('div', { class: 'big', text: num(d.totals.total) }), h('div', { class: 'label', text: t('usage.tokens') })),
      h('div', { class: 'kpi' }, h('div', { class: 'big', text: num(d.totals.messages) }), h('div', { class: 'label', text: t('usage.messages') })),
      h('div', { class: 'kpi' }, h('div', { class: 'big', text: money(d.cost_total) }), h('div', { class: 'label', text: d.cost_total === null ? t('usage.noPrices') : d.cost_partial ? t('usage.costPartial') : t('usage.cost') }))));
    // stacked daily bars (heights set through the CSS object model, which a strict CSP allows)
    var max = Math.max.apply(null, d.daily.map(function (x) { return x.total; }).concat([1]));
    var bars = h('div', { class: 'bars', role: 'img', 'aria-label': t('usage.daily') });
    var axis = h('div', { class: 'axis', 'aria-hidden': 'true' });
    d.daily.forEach(function (day) {
      var col = h('div', { class: 'col' });
      col.style.height = (day.total / max * 100) + '%';
      FAMS.forEach(function (f) {
        var fam = day.families[f];
        if (!fam || !fam.total) return;
        var seg = h('div', { class: 'seg f-' + f, title: f + ' ' + num(fam.total) });
        seg.style.height = (fam.total / day.total * 100) + '%';
        col.appendChild(seg);
      });
      bars.appendChild(h('div', { class: 'bar', title: day.day + ': ' + num(day.total) }, col));
      axis.appendChild(h('span', { text: day.day.slice(5) }));
    });
    var legend = h('div', { class: 'legend' }, FAMS.map(function (f) { return h('span', null, h('i', { class: 'dot f-' + f }), f); }));
    root.appendChild(card(t('usage.daily'), h('div', null, bars, axis, legend)));
    var rows = d.models.map(function (m) {
      return h('tr', null, td(m.model), td(m.engine), td(num(m.input), true), td(num(m.output), true), td(num(m.cache_write), true), td(num(m.cache_read), true), td(num(m.messages), true), td(money(m.cost), true));
    });
    root.appendChild(card(t('usage.models'), d.models.length
      ? table([t('usage.model'), t('sessions.engine'), t('usage.input'), t('usage.output'), t('usage.cacheWrite'), t('usage.cacheRead'), t('usage.messages'), t('usage.cost')], rows, [2, 3, 4, 5, 6, 7]) : empty('usage.none')));
    root.appendChild(h('details', { class: 'card' }, h('summary', { text: t('usage.table') }),
      table([t('usage.day'), t('usage.tokens')], d.daily.map(function (x) { return h('tr', null, td(x.day), td(num(x.total), true)); }), [1])));
    return root;
  }

  // ------------------------------------------------------------------ settings form (from config.SCHEMA)
  var FORM_TYPES = ['string', 'integer', 'number', 'boolean', 'array'];

  // concrete leaf paths of the loaded config that a schema entry describes
  function expandPaths(obj, schemaPath) {
    var level = [{ path: '', value: obj }];
    schemaPath.split('.').forEach(function (seg) {
      var next = [];
      level.forEach(function (it) {
        if (!it.value || typeof it.value !== 'object' || Array.isArray(it.value)) return;
        var keys = seg === '*' ? Object.keys(it.value) : (seg in it.value ? [seg] : []);
        keys.forEach(function (k) { next.push({ path: it.path ? it.path + '.' + k : k, value: it.value[k] }); });
      });
      level = next;
    });
    return level;
  }
  function setIn(obj, path, value) {
    var keys = path.split('.');
    var cur = obj;
    for (var i = 0; i < keys.length - 1; i++) { if (!cur[keys[i]]) cur[keys[i]] = {}; cur = cur[keys[i]]; }
    cur[keys[keys.length - 1]] = value;
  }

  function settingsPage(schema, cfg, projectId, onSaved) {
    var fields = [];
    schema.forEach(function (e) {
      if (FORM_TYPES.indexOf(e.type) < 0 || e.path === 'version') return;
      expandPaths(cfg.config, e.path).forEach(function (c) { fields.push({ entry: e, path: c.path, value: c.value }); });
    });
    var inputs = {};
    var groups = {};
    var order = [];
    fields.forEach(function (f) {
      var top = f.path.split('.')[0];
      if (!groups[top]) { groups[top] = h('fieldset', null, h('legend', { text: top })); order.push(top); }
      var el;
      var e = f.entry;
      if (e.type === 'boolean') el = h('input', { type: 'checkbox', id: 'f-' + f.path, checked: !!f.value });
      else if (e.enum) el = h('select', { id: 'f-' + f.path }, e.enum.map(function (v) { return h('option', { value: String(v), selected: v === f.value, text: String(v) }); }));
      else if (e.type === 'integer' || e.type === 'number') el = h('input', { type: 'number', id: 'f-' + f.path, value: f.value, min: e.min, max: e.max, step: e.type === 'integer' ? 1 : 'any' });
      else if (e.type === 'array') el = h('textarea', { id: 'f-' + f.path, rows: Math.max(2, (f.value || []).length), value: (f.value || []).join('\n') });
      else el = h('input', { type: 'text', id: 'f-' + f.path, value: f.value === undefined ? '' : f.value });
      var desc = (e.description && (e.description[S.lang] || e.description.en)) || '';
      var msg = h('div', { class: 'err', id: 'm-' + f.path, role: 'alert' });
      el.setAttribute('aria-describedby', 'd-' + f.path + ' m-' + f.path);
      var row = h('div', { class: 'field', 'data-path': f.path },
        h('label', { class: 'path', for: 'f-' + f.path, text: f.path }), el,
        h('div', { class: 'muted desc', id: 'd-' + f.path, text: desc + (e.type === 'array' ? ' ' + t('settings.onePerLine') : '') }), msg);
      inputs[f.path] = { el: el, entry: e, orig: f.value, row: row, msg: msg };
      groups[top].appendChild(row);
    });
    var status = h('span', { role: 'status' });
    var summary = h('div', { class: 'err', role: 'alert' });

    function read(f) {
      var el = f.el;
      var e = f.entry;
      if (e.type === 'boolean') return el.checked;
      if (e.type === 'integer' || e.type === 'number') {
        if (el.value.trim() === '') return undefined;
        var n = Number(el.value);
        return e.type === 'integer' && !Number.isInteger(n) ? NaN : n;
      }
      if (e.type === 'array') return el.value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
      return el.value;
    }
    function save() {
      var changes = {};
      var n = 0;
      var bad = false;
      Object.keys(inputs).forEach(function (p) {
        var f = inputs[p];
        f.row.classList.remove('bad');
        f.msg.textContent = '';
        var v = read(f);
        if (v === undefined || (typeof v === 'number' && isNaN(v))) { f.row.classList.add('bad'); f.msg.textContent = t('settings.needNumber'); bad = true; return; }
        if (JSON.stringify(v) !== JSON.stringify(f.orig)) { setIn(changes, p, v); n++; }
      });
      summary.textContent = '';
      status.textContent = '';
      if (bad) return;
      if (!n) { status.textContent = t('settings.noChanges'); return; }
      api(projectId ? '/api/project/' + projectId + '/config' : '/api/config', { body: { config: changes } }).then(function (r) {
        if (r.status >= 400) {
          var d = r.data;
          (d.errors || []).forEach(function (er) {
            var f = inputs[er.path.replace(/\[\d+\]$/, '')];
            if (f) { f.row.classList.add('bad'); f.msg.textContent = er.message; } else summary.appendChild(h('div', { text: er.path + ': ' + er.message }));
          });
          if (!(d.errors || []).length) summary.appendChild(h('div', { text: (d.error && d.error.message) || 'Error' }));
          status.textContent = t('settings.failed');
          return;
        }
        status.textContent = t('settings.saved');
        onSaved();
      }).catch(function () { /* offline banner already shown */ });
    }
    var form = h('form', { novalidate: true, onsubmit: function (e) { e.preventDefault(); save(); } },
      order.map(function (k) { return groups[k]; }),
      h('div', { class: 'sticky' }, h('button', { class: 'primary', type: 'submit', text: t('save') }), status, summary));
    var intro = [];
    if (cfg.errors.length) intro.push(card(t('config.errors'), h('ul', { class: 'list' }, cfg.errors.map(function (e) { return h('li', { class: 'err', text: e.path + ': ' + e.message }); })), 'alert'));
    if ((cfg.warnings || []).length) intro.push(card(t('config.ignored'), h('ul', { class: 'list' }, cfg.warnings.map(function (e) { return h('li', { class: 'muted', text: e.path + ': ' + e.message }); })), 'alert'));
    return h('div', null, h('h1', { text: t(projectId ? 'settings.project' : 'settings.global') }), h('p', { class: 'muted', text: t('settings.hint') }), intro, form);
  }

  // ------------------------------------------------------------------ office (drawn by office.js)
  function officePage(d) {
    if (!window.Office) return empty('office.none');
    // a session page is used when this build has one (#/s/<id>); otherwise the sessions list, filtered to that project
    var hasSession = parseHash('#/s/x').page !== 'overview';
    return window.Office.page(d, {
      t: t, ago: ago, pname: pname, mask: S.mask,
      stats: function (r) {   // compact numbers only: duration · tokens · cost
        var c = SM.cardStats(r);
        if (!c) return null;
        var parts = [SM.fmtDuration(c.duration)];
        if (c.tokens) parts.push(t('stats.lineTokens', { count: SM.compact(c.tokens) }));
        if (c.cost !== null) parts.push(costText(c.cost, c.costComplete));
        return parts.join(' · ');
      },
      href: function (r) { return hasSession ? '#/s/' + encodeURIComponent(r.id) : '#/sessions'; },
      prepare: function (r) { if (!hasSession) saveFilter({ project: r.project || '-', state: 'all', engine: 'all' }); }
    });
  }

  // ------------------------------------------------------------------ refresh loop
  function render(node, sig) {
    var main = $('main');
    var act = document.activeElement;
    // never replace the page under a field the user is typing into
    if (S.last === sig) return;
    if (act && main.contains(act) && /^(INPUT|TEXTAREA|SELECT)$/.test(act.tagName) && act.value && S.lastRoute === S.routeKey) return;
    S.last = sig;
    S.lastRoute = S.routeKey;
    main.textContent = '';
    main.appendChild(node);
  }

  function refresh(force) {
    if (S.busy) return;
    S.route = parseRoute();
    S.routeKey = JSON.stringify(S.route);
    if (force) S.last = '';
    renderChrome();
    var r = S.route;
    var tag = S.lang + S.mask + S.routeKey;
    S.busy = true;
    var done = function () { S.busy = false; };
    var fail = function () { S.busy = false; };
    if (r.page === 'session') {
      if (!SM.validId(r.id)) { render(card(t('error'), h('p', { class: 'err', text: t('sessions.gone') })), 'sgone' + tag); done(); return; }
      if (DET.id !== r.id) detReset(r.id);
      var asked = r.id;
      api('/api/session/' + asked + detQuery()).then(function (res) {
        if (DET.id !== asked) return;
        if (res.status >= 400) { render(card(t('error'), h('p', { class: 'err', text: res.status === 404 ? t('sessions.gone') : (res.data.error ? res.data.error.message : 'Error') })), 'sgone' + tag); return; }
        DET.data = res.data;
        DET.tl = SM.mergeLatest(DET.tl, res.data);
        var sig = 'sd' + tag + JSON.stringify([res.data.session, res.data.children, DET.tl.events.length, DET.tl.cursor, DET.loading, DET.kinds, DET.tl.events.slice(-3)]);
        if (S.last === sig) return;
        var fid = document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-fid') : null;
        render(sessionDetailPage(), sig);
        if (fid) { var el = document.querySelector('[data-fid="' + fid + '"]'); if (el) { try { el.focus(); } catch (e) { /* ignore */ } } }
      }).then(done, fail);
      return;
    }
    if (r.page === 'settings' || r.page === 'psettings') {
      if (!force && S.last.indexOf('settings') === 0) { done(); return; }   // do not refresh a form while editing
      var pid = r.page === 'psettings' ? r.id : null;
      Promise.all([api('/api/schema'), api(pid ? '/api/project/' + pid + '/config' : '/api/config')]).then(function (rs) {
        if (rs[1].status >= 400) { render(card(t('error'), h('p', { class: 'err', text: rs[1].data.error.message })), 'settings-err'); return; }
        var schema = pid ? rs[0].data.project : rs[0].data.global;
        render(settingsPage(schema, rs[1].data, pid, function () { S.last = ''; refresh(true); }), 'settings' + tag + Date.now());
      }).then(done, fail);
      return;
    }
    var path = r.page === 'overview' ? '/api/overview' : r.page === 'project' ? '/api/project/' + encodeURIComponent(r.id) : r.page === 'sessions' || r.page === 'office' ? '/api/sessions' : '/api/usage';
    api(path).then(function (res) {
      if (res.status >= 400) { render(card(t('error'), h('p', { class: 'err', text: res.data.error ? res.data.error.message : 'Error' })), 'err' + tag); return; }
      var d = res.data;
      var node = r.page === 'overview' ? overviewPage(d) : r.page === 'project' ? projectPage(d) : r.page === 'sessions' ? sessionsPage(d) : r.page === 'office' ? officePage(d) : usagePage(d);
      render(node, tag + JSON.stringify(d));
    }).then(done, fail);
  }

  function startTimer() {
    if (S.timer) clearInterval(S.timer);
    S.timer = setInterval(function () { if (document.visibilityState === 'visible') refresh(false); }, 4000);
  }

  // ------------------------------------------------------------------ boot
  function boot() {
    var saved = store('crew.lang');
    S.lang = saved === 'zh-TW' || saved === 'en' ? saved : ((navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh-TW' : 'en');
    S.mask = store('crew.mask') === '1';
    try { S.sf = SM.cleanFilter(JSON.parse(store('crew.sessionFilter') || '{}')); } catch (e) { S.sf = SM.cleanFilter({}); }
    try { var so = JSON.parse(store('crew.sessionOpen') || '{}'); S.sopen = so && typeof so === 'object' && !Array.isArray(so) ? so : {}; } catch (e) { S.sopen = {}; }
    loadTables().then(function () {
      S.route = parseRoute();
      renderChrome();
      window.addEventListener('hashchange', function () { S.last = ''; refresh(true); });
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refresh(false); });
      showUpdated();
      refresh(true);
      loadUpdate();
      setInterval(function () { if (document.visibilityState === 'visible') loadUpdate(); }, 60000);
      startTimer();
    });
  }
  boot();
}());
