(function () {
  'use strict';

  // ------------------------------------------------------------------ state and helpers
  var $ = function (id) { return document.getElementById(id); };
  var TOKEN = (document.querySelector('meta[name="crew-token"]') || {}).content || '';
  var S = { lang: 'en', mask: false, sf: null, sopen: {}, tables: {}, meta: null, timer: null, last: '', route: null, busy: false, offline: false, pcollapsed: {}, pgrowth: false, office: { state: 'missing' } };

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
  // count: optional number shown next to the title ("12 items")
  function card(title, body, extra, count) {
    return h('section', { class: 'card' + (extra ? ' ' + extra : '') },
      h('h2', null, title, count === undefined || count === null ? null : h('span', { class: 'count muted', text: ' · ' + plural('cap.items', count) })), body);
  }
  // A list or table with a capped height that scrolls inside the card. The page keeps its length; the area is
  // focusable and named so a keyboard user can scroll it. mod: 'tall' (main content of a card page) or 'main' (the page itself).
  // key: a stable structural id of the section on its page ("tasks", "work:<stream>", "day:<yyyy-mm-dd>"), never a title;
  // it keeps the scroll position and focus across a re-render (see render)
  function cap(key, label, child, mod) {
    return h('div', { class: 'cap' + (mod ? ' ' + mod : ''), tabindex: '0', role: 'region', 'aria-label': label, 'data-cap': key }, child);
  }
  // capKey / capLabel: make the table a capped scroll area (see cap)
  function table(head, rows, numCols, capKey, capLabel, mod) {
    numCols = numCols || [];
    var attrs = capKey ? { class: 'scroll cap' + (mod ? ' ' + mod : ''), tabindex: '0', role: 'region', 'aria-label': capLabel, 'data-cap': capKey } : { class: 'scroll' };
    return h('div', attrs, h('table', null,
      h('thead', null, h('tr', null, head.map(function (c, i) { return h('th', { scope: 'col', class: numCols.indexOf(i) >= 0 ? 'num' : '', text: c }); }))),
      h('tbody', null, rows)));
  }
  function td(content, num) { return h('td', { class: num ? 'num' : '' }, content); }

  // ------------------------------------------------------------------ update banner
  // The server does the check and the update (DESIGN section 10); this only shows the state and asks.
  // S.upd: { info, phase: idle|running|restarting|manual|failed|done, status, oldVersion, since, doneVersion }
  var UM = window.UpdateModel;
  var UPD_LIMIT = 45000;
  S.upd = { info: null, phase: 'idle', status: null, oldVersion: '', since: 0, doneVersion: '', old: null, cleaning: false, cleanMsg: '' };

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

  function toolName(x) { return x === 'codex' ? 'Codex' : 'Claude'; }
  function reasonText(code, tool) { var key = 'update.reason.' + code;
    return t(key, { tool: toolName(tool) }); }

  // one line per tool: updated / skipped (not installed) / manual (CLI not found) / failed
  function resultList(results) {
    if (!results || !results.length) return [];
    return [h('ul', { class: 'results' }, results.map(function (r) {
      var why = r.reason ? ' (' + reasonText(r.reason, r.tool) + ')' : '';
      var key = 'update.result.' + r.status;
      return h('li', { text: t(key, { tool: toolName(r.tool) }) + why });
    }))];
  }

  // the exact commands of every tool that has to be run by hand, each with its reason and a Copy button
  function manualBlocks(manual) {
    var out = [];
    (manual || []).forEach(function (g) {
      out.push(h('p', { class: 'note', text: toolName(g.tool) + (g.reason ? ' - ' + reasonText(g.reason, g.tool) : '') }));
      commandBlock(g.commands).forEach(function (x) { out.push(x); });
    });
    return out;
  }

  // old versions that stay behind after an update; removing them is the user's call
  function loadOld() {
    api('/api/update/cleanup').then(function (r) {
      if (r.status < 400) { S.upd.old = r.data; renderUpdate(); }
    }).catch(function () { /* optional */ });
  }

  function removeOld() {
    var u = S.upd;
    u.cleaning = true;
    u.cleanMsg = '';
    renderUpdate();
    api('/api/update/cleanup', { body: {} }).then(function (r) {
      u.cleaning = false;
      var d = r.data || {};
      var kept = (d.kept || []).length;
      u.cleanMsg = r.status >= 400 ? ((d.error && d.error.message) || '') : t('update.removedOld', { count: (d.removed || []).length, mb: mb(d.freed || 0) }) + (kept ? ' ' + t('update.keptOld', { count: kept }) : '');
      u.old = null;
      loadOld();
      renderUpdate();
    }).catch(function () { u.cleaning = false; renderUpdate(); });
  }

  function mb(n) { return (n / 1048576).toFixed(1); }

  function oldBlock(u) {
    var out = [];
    if (u.old && u.old.count) {
      out.push(h('p', { class: 'note', text: t('update.oldVersions', { count: u.old.count, mb: mb(u.old.bytes) }) }));
      out.push(h('span', { class: 'btns' }, h('button', { type: 'button', disabled: u.cleaning ? 'disabled' : null, onclick: removeOld, text: t(u.cleaning ? 'update.removing' : 'update.removeOld') })));
    }
    if (u.cleanMsg) out.push(h('p', { class: 'note', role: 'status', text: u.cleanMsg }));
    return out;
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
    var sig = JSON.stringify([S.lang, u.phase, info, u.status, u.doneVersion, u.old, u.cleaning, u.cleanMsg, store('crew.skipUpdate') || '']);
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
      extra = resultList(u.status && u.status.results);
      var left = (u.status && u.status.manual) || [];
      if (left.length) extra = extra.concat([h('p', { class: 'note', text: t('update.manual') })], manualBlocks(left));
      extra = extra.concat(oldBlock(u));
    } else if (u.phase === 'manual') {
      var mst = u.status || {};
      line = [h('span', { class: 'msg', text: t('update.manual') }), dismissBtn()];
      extra = resultList(mst.results).concat(manualBlocks(mst.manual), [h('p', { class: 'note', text: t('update.restartLine') })], commandBlock([mst.restart_command || 'crew board start']));
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
        if (v === 'ok') {
          store('crew.updated', hl.version);
          store('crew.updatedInfo', JSON.stringify({ results: (u.status && u.status.results) || [], manual: (u.status && u.status.manual) || [] }));
          window.location.reload();
          return;
        }
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
      var step = UM.statusStep(u.phase, d.state);
      if (step === 'running') { renderUpdate(); again(); return; }
      if (step === 'restart') { toRestart(); return; }
      if (step === 'manual') u.phase = 'manual';
      else if (step === 'failed') u.phase = 'failed';
      else if (step === 'done') { u.phase = 'done'; u.doneVersion = d.new_version || ''; loadOld(); } else u.phase = 'idle';
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
    try { S.upd.status = JSON.parse(store('crew.updatedInfo') || '{}'); } catch (e) { S.upd.status = {}; }
    store('crew.updatedInfo', '');
    loadOld();
  }

  // ------------------------------------------------------------------ routing
  function parseRoute() { return parseHash(location.hash); }
  function parseHash(hash) {
    var p = (hash || '#/').replace(/^#/, '').split('/').filter(Boolean);
    if (!p.length) return { page: 'overview' };
    if (p[0] === 'p' && p[1]) return p[2] === 'settings' ? { page: 'psettings', id: p[1] } : p[2] === 'plan' && /^[a-z0-9-]{1,40}$/.test(p[3] || '') ? { page: 'plan', id: p[1], slug: p[3] } : { page: 'project', id: p[1] };
    if (p[0] === 's' && p[1]) return { page: 'session', id: p[1] };
    if (['sessions', 'office', 'history', 'usage', 'settings'].indexOf(p[0]) >= 0) return { page: p[0] };
    return { page: 'overview' };
  }

  function renderChrome() {
    document.documentElement.lang = S.lang;
    document.title = 'crewgate – ' + t('title');
    $('skip').textContent = t('skip');
    $('nav').setAttribute('aria-label', t('nav'));
    var page = S.route.page;
    var items = [['overview', '#/', t('nav.overview')], ['sessions', '#/sessions', t('nav.sessions')], ['history', '#/history', t('nav.history')], ['usage', '#/usage', t('nav.usage')], ['settings', '#/settings', t('nav.settings')]];
    if (S.office.state !== 'missing') items.splice(3, 0, ['office', '#/office', t('office.nav')]);   // the add-on is optional
    var nav = $('nav');
    nav.textContent = '';
    items.forEach(function (it) {
      var cur = it[0] === page || (it[0] === 'overview' && (page === 'project' || page === 'psettings' || page === 'plan')) || (it[0] === 'sessions' && page === 'session');
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
    var list = h('div', { class: 'card cap main', role: 'table', tabindex: '0', 'aria-label': t('nav.overview'), 'data-cap': 'overview' });
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

  // Small muted suffix of an event row: where it came from (via), merged branches, a subagent's last words.
  function eventNote(e, showText) {
    var x = e.data || {};
    var bits = [];
    if (x.via) bits.push(t('events.via') + ' ' + x.via);
    if (x.agent_type) bits.push(x.agent_type);
    if (Array.isArray(x.branches) && x.branches.length) bits.push(x.branches.join(', '));
    if (x.dynamic) bits.push(t('events.dynamic'));
    if (showText && x.last) bits.push(x.last);
    return bits.length ? h('span', { class: 'muted', text: ' · ' + bits.join(' · ') }) : '';
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
      needBody.appendChild(cap('needs', t('project.needs'), h('ul', { class: 'list' }, d.needs.open.map(function (n) {
        return h('li', null, '#' + n.id + ' ' + n.text + ' ', h('button', { class: 'link', text: t('need.done'), onclick: function () { post('/api/project/' + id + '/need/done', { id: n.id }); } }));
      }))));
    } else needBody.appendChild(empty('need.none'));
    needBody.appendChild(formRow([h('input', { type: 'text', name: 'text', required: true, 'aria-label': t('need.add'), placeholder: t('need.add'), size: 30 })], t('add'),
      function (f) { post('/api/project/' + id + '/need', { text: f.elements.text.value }, function () { f.reset(); }); }));
    root.appendChild(card(t('project.needs'), needBody, d.needs.open.length ? 'alert' : '', d.needs.open.length));

    // tasks
    var rows = d.tasks.slice().sort(function (a, b) { return TASK_ORDER.indexOf(a.state) - TASK_ORDER.indexOf(b.state); }).map(function (tk) {
      return h('tr', null,
        td(h('details', null, h('summary', { text: tk.title || tk.id }),
          h('ul', { class: 'list' }, tk.history.map(function (x) { return h('li', { class: 'muted', text: when(x.ts) + ' · ' + x.state + (x.note ? ' · ' + x.note : '') }); })),
          h('code', { text: tk.id }))),
        td(badge(tk.state)), td(String(tk.returns), true), td(tk.role || ''), td(reviewText(tk.review)), td(ago(tk.updated)));
    });
    root.appendChild(card(t('project.tasks'), d.tasks.length
      ? table([t('task.title'), t('task.state'), t('task.returns'), t('task.role'), t('task.review'), t('task.updated')], rows, [2], 'tasks', t('project.tasks'), 'tall') : empty('task.none'), '', d.tasks.length));

    root.appendChild(plansCard(d));

    var grid = h('div', { class: 'grid' });
    // live sessions
    grid.appendChild(card(t('project.sessions'), d.sessions.length ? cap('sessions', t('project.sessions'), sessionTree(d.sessions, false, null)) : empty('sessions.none'), '', d.sessions.length));
    // work
    var workBody = h('div', null);
    if (!d.work.length) workBody.appendChild(empty('work.none'));
    d.work.forEach(function (s) {
      workBody.appendChild(h('h3', { text: s.name }));
      workBody.appendChild(cap('work:' + s.name, s.name, h('ul', { class: 'list' }, s.items.map(function (it) {
        return h('li', null, badge(it.state), ' ' + it.title + (it.note ? ' – ' + it.note : '') + ' ',
          h('button', { class: 'link', text: t('remove'), onclick: function () { post('/api/project/' + id + '/work/rm', { stream: s.name, title: it.title }); } }));
      }))));
    });
    workBody.appendChild(formRow([
      h('input', { type: 'text', name: 'stream', required: true, placeholder: t('work.stream'), 'aria-label': t('work.stream'), size: 10 }),
      h('input', { type: 'text', name: 'title', required: true, placeholder: t('work.item'), 'aria-label': t('work.item'), size: 16 }),
      h('select', { name: 'state', 'aria-label': t('task.state') }, ['todo', 'doing', 'done', 'waiting', 'parked'].map(function (s) { return h('option', { value: s, text: t('state.' + s) }); })),
    ], t('add'), function (f) { post('/api/project/' + id + '/work', { stream: f.elements.stream.value, title: f.elements.title.value, state: f.elements.state.value }, function () { f.reset(); }); }));
    grid.appendChild(card(t('project.work'), workBody, '', d.work.reduce(function (n, s) { return n + s.items.length; }, 0)));
    // log
    var logBody = h('div', null, d.log.length ? cap('log', t('project.log'), h('ul', { class: 'list' }, d.log.slice(0, 15).map(function (l) { return h('li', null, h('span', { class: 'muted', text: ago(l.time) + ' · ' + l.who + ' · ' }), l.text); }))) : empty('log.none'));
    logBody.appendChild(formRow([h('input', { type: 'text', name: 'text', required: true, placeholder: t('log.add'), 'aria-label': t('log.add'), size: 30 })], t('add'),
      function (f) { post('/api/project/' + id + '/log', { who: 'board', text: f.elements.text.value }, function () { f.reset(); }); }));
    grid.appendChild(card(t('project.log'), logBody, '', Math.min(d.log.length, 15)));
    // merge requests and validation
    grid.appendChild(card(t('project.mrs'), d.mrs.length
      ? table(['!', t('task.title'), 'CI', t('mr.merged')], d.mrs.map(function (m) { return h('tr', null, td('!' + m.iid), td(m.title), td(m.ci ? badge(m.ci, m.ci) : ''), td(m.merged ? t('yes') : t('no'))); }), [], 'mrs', t('project.mrs')) : empty('mr.none'), '', d.mrs.length));
    var vrows = [];
    Object.keys(d.validation).forEach(function (k) { (d.validation[k] || []).forEach(function (r) { vrows.push(h('tr', null, td(k), td(r.date), td(r.host), td(r.result))); }); });
    grid.appendChild(card(t('project.validation'), vrows.length ? table([t('validation.id'), t('validation.date'), t('validation.host'), t('validation.result')], vrows, [], 'validation', t('project.validation')) : empty('validation.none'), '', vrows.length));
    // handoffs
    var hitems = [];
    ['open', 'accepted', 'cancelled'].forEach(function (st) {
      (d.handoffs[st] || []).forEach(function (x) {
        hitems.push(h('li', null, badge(st === 'open' ? 'waiting' : st, t('handoff.' + st)), ' ' + (x.title || x.id) + (x.task ? ' · ' + x.task : '')));
      });
    });
    grid.appendChild(card(t('project.handoffs'), hitems.length ? cap('handoffs', t('project.handoffs'), h('ul', { class: 'list' }, hitems)) : empty('handoff.none'), '', hitems.length));
    // lessons
    var L = d.lessons;
    var lb = h('div', null);
    if (!L.exists || !L.total) lb.appendChild(empty('lessons.none'));
    else {
      lb.appendChild(h('p', { class: 'muted', text: t('lessons.summary', { total: L.total, keys: L.keys.length, candidates: L.candidates }) }));
      lb.appendChild(table([t('lessons.key'), t('lessons.count'), t('lessons.days'), t('lessons.last'), ''], L.keys.slice(0, 12).map(function (k) {
        return h('tr', null, td(k.key), td(String(k.count), true), td(String(k.days), true), td(k.last), td(k.candidate ? badge('waiting', t('lessons.candidate')) : ''));
      }), [1, 2], 'lessons', t('project.lessons')));
    }
    grid.appendChild(card(t('project.lessons'), lb, '', L.exists ? L.total : null));
    root.appendChild(grid);
    // approval gates and hook wiring
    var gateRows = (d.gates || []).slice(0, 15).map(function (g) {
      var st = g.missing ? badge('failed', t('gate.missing')) : g.answer ? badge(g.answer === 'yes' ? 'done' : 'failed', t(g.answer === 'yes' ? 'gate.yes' : 'gate.no') + (g.auto ? ' (' + t('gate.auto') + ')' : '')) : badge('waiting', t('gate.asked'));
      return h('tr', null, td(ago(g.ts)), td(g.gate || ''), td(g.task || ''), td(st), td(g.missing ? g.detail : (g.note || g.detail || '')));
    });
    grid.appendChild(card(t('project.gates'), gateRows.length ? table([t('gate.when'), t('gate.gate'), t('gate.task'), t('gate.state'), t('gate.detail')], gateRows, [], 'gates', t('project.gates')) : empty('gate.none'), '', gateRows.length));
    var hs = d.hook_seen || { rows: [], missing: [] };
    var hbody = h('div', null);
    if (hs.missing.length) hbody.appendChild(h('p', { class: 'err', text: t('hooks.missing', { events: hs.missing.join(', ') }) }));
    hbody.appendChild(table([t('hooks.event'), t('hooks.last')], hs.rows.map(function (r) { return h('tr', null, td(r.event), td(r.last ? ago(r.last) : t('hooks.never'))); }), [], 'hooks', t('project.hooks')));
    grid.appendChild(card(t('project.hooks'), hbody, hs.missing.length ? 'alert' : ''));
    // events
    root.appendChild(card(t('project.events'), d.events.length
      ? cap('events', t('project.events'), h('ul', { class: 'list' }, d.events.slice(0, 25).map(function (e) { return h('li', null, h('span', { class: 'muted', text: ago(e.ts) + ' · ' }), h('code', { text: e.type }), e.task ? ' ' + e.task : '', eventNote(e, d.show_text)); })), 'tall')
      : empty('events.none'), '', Math.min(d.events.length, 25)));
    return root;
  }

  // ------------------------------------------------------------------ plans
  var PM = window.PlanModel;

  function planChip(state) {
    return h('span', { class: 'badge ps ps-' + state }, h('span', { class: 'glyph', 'aria-hidden': 'true', text: PM.mark(state) }), t('plan.state.' + state));
  }
  function planBar(pct, label) {
    return h('progress', { class: 'pbar', max: 100, value: pct, 'aria-label': label, title: pct + '%' });
  }
  function planCounts(s) {
    var bits = [];
    if (s.blocked) bits.push(planChip('blocked'));
    if (s.proposed) bits.push(h('span', { class: 'badge ps ps-proposed', text: t('plan.proposedN', { count: s.proposed }) }));
    if (s.dropped) bits.push(h('span', { class: 'badge ps ps-dropped', text: t('plan.droppedN', { count: s.dropped }) }));
    return bits;
  }

  // Project page card: one row per plan with a progress bar.
  function plansCard(d) {
    var list = d.plans || [];
    var body = list.length ? cap('plans', t('project.plans'), h('ul', { class: 'list plans' }, list.map(function (p) {
      var name = PM.planTitle(p, S.mask);
      return h('li', null,
        h('a', { href: '#/p/' + encodeURIComponent(d.project.id) + '/plan/' + encodeURIComponent(p.slug), text: name }),
        h('div', { class: 'prow' }, planBar(p.pct, name), h('span', { class: 'pct', text: p.pct + '%' }), h('span', { class: 'muted', text: t('plan.steps', { done: p.done, total: p.total }) }), planCounts(p)));
    }))) : h('div', null, empty('plan.none'), h('pre', { class: 'cmd', text: 'crew plan new SLUG --title "..."' }));
    var waiting = PM.pendingTotal(list);
    if (waiting) body = h('div', null, h('p', { class: 'pending' }, h('span', { class: 'badge ps ps-proposed', text: plural('plan.pendingProject', waiting) })), body);
    return card(t('project.plans'), body, '', list.length ? list.length : null);
  }

  function toggleCollapsed(key) {
    if (S.pcollapsed[key]) delete S.pcollapsed[key]; else S.pcollapsed[key] = true;
    store('crew.planCollapsed', JSON.stringify(S.pcollapsed));
    S.last = '';
    refresh(true);
  }

  // kind, action and the uncertain mark of a proposal (words, not colour alone)
  function proposalMarks(p) {
    var out = [];
    if (p.kind) out.push(h('span', { class: 'badge pk', text: t('plan.kind.' + p.kind) }));
    if (p.action) out.push(h('span', { class: 'badge pa', text: t('plan.action.' + p.action) }));
    if (p.uncertain) out.push(h('span', { class: 'badge ps ps-uncertain', text: '? ' + t('plan.uncertain') }));
    return out;
  }

  function propRow(label, value) {
    return h('div', { class: 'prow2' }, h('strong', { text: label + ': ' }), value);
  }

  // One proposal waiting for a decision. The board is read-only: the commands are shown to copy.
  function proposalItem(p, d) {
    var li = h('li', { class: 'pprop' + (p.uncertain ? ' is-uncertain' : '') });
    li.appendChild(h('div', { class: 'phead' },
      S.mask ? null : h('code', { text: p.id }),
      proposalMarks({ kind: p.kind, action: p.action, uncertain: p.uncertain }),
      p.verdict && !p.uncertain ? h('span', { class: 'badge', text: t('plan.verdict.' + p.verdict) }) : null,
      p.round ? h('span', { class: 'muted', text: t('plan.prop.round', { round: p.round }) }) : null));
    li.appendChild(propRow(t('plan.prop.about'), p.target ? PM.targetText(p, S.mask) : t('plan.prop.whole')));
    li.appendChild(propRow(t('plan.prop.proposal'), PM.proposalText(p, S.mask)));
    if (p.done_when && !S.mask) li.appendChild(propRow(t('plan.prop.doneWhen'), p.done_when));
    if (p.from_task) li.appendChild(propRow(t('plan.prop.fromTask'), p.from_task));
    if (!S.mask && p.claim) {
      li.appendChild(propRow(t('plan.prop.claim'), p.claim));
      if (p.evidence && p.evidence.length) li.appendChild(propRow(t('plan.prop.evidence'), p.evidence.join(' · ')));
      if (p.refutation) li.appendChild(propRow(t('plan.prop.refuter'), typeof p.refutation === 'string' ? p.refutation : [].concat(p.refutation).join(' · ')));
    } else if (!S.mask && p.round && !d.show_text) li.appendChild(h('p', { class: 'muted', text: t('plan.prop.textOff') }));
    li.appendChild(h('div', { class: 'pcmds' }, commandBlock([p.accept_cmd, p.reject_cmd])));
    return li;
  }

  function proposalsCard(d) {
    var list = PM.pending(d);
    if (!list.length) return null;
    return card(plural('plan.pendingTitle', list.length), h('div', null,
      h('p', { class: 'muted', text: t('plan.prop.hint') }),
      h('ul', { class: 'pprops' }, list.map(function (p) { return proposalItem(p, d); }))));
  }

  function planNode(n, pid, slug, recent) {
    var key = PM.collapseKey(pid, slug, n.id);
    var kids = n.children.length;
    var open = !S.pcollapsed[key];
    var text = PM.nodeText(n, S.mask);
    var li = h('li', { class: 'pnode' + (recent[n.id] ? ' is-new' : '') + (n.state === 'dropped' ? ' is-dropped' : '') + (n.state === 'proposed' ? ' is-proposal' : '') });
    var head = h('div', { class: 'phead' },
      kids ? h('button', { type: 'button', class: 'toggle', 'data-fid': 'pt-' + n.id, 'aria-expanded': open ? 'true' : 'false', 'aria-label': t(open ? 'plan.collapse' : 'plan.expand') + ': ' + text, onclick: function () { toggleCollapsed(key); }, text: open ? '▾' : '▸' }) : h('span', { class: 'toggle spacer' }),
      planChip(n.state),
      h('span', { class: 'ptext', text: text }),
      kids && n.state !== 'dropped' && n.state !== 'proposed' ? h('span', { class: 'pct', text: n.pct + '% · ' + n.done + '/' + n.total }) : null);
    li.appendChild(head);
    var meta = h('div', { class: 'pmeta muted' });
    if (!S.mask) meta.appendChild(h('code', { text: n.id }));
    if (n.task && PM.validTask(n.task.id)) {
      meta.appendChild(h('span', null, ' · ' + t('plan.task') + ' ', h('code', { text: n.task.id }), ' ', n.task.missing ? h('span', { class: 'badge s-failed', text: t('plan.taskMissing') }) : badge(n.task.state)));
    }
    if (n.origin !== 'plan') meta.appendChild(h('span', { class: 'badge po po-' + n.origin, text: t('plan.origin.' + n.origin) }));
    if (n.proposal) proposalMarks(n.proposal).forEach(function (m) { meta.appendChild(m); });
    if (n.added) meta.appendChild(h('span', { text: ' · ' + t('plan.added', { date: n.added }) }));
    if (recent[n.id]) meta.appendChild(h('span', { class: 'badge ps ps-new', text: t('plan.new') }));
    li.appendChild(meta);
    if (kids && open) li.appendChild(h('ul', { class: 'ptree' }, n.children.map(function (c) { return planNode(c, pid, slug, recent); })));
    return li;
  }

  function roundsTable(list) {
    if (!list.length) return h('p', { class: 'empty', text: t('plan.rounds.none') });
    return table([t('plan.rcol.date'), t('plan.rcol.round'), t('plan.rcol.raised'), t('plan.rcol.refuted'), t('plan.rcol.kept'), t('plan.rcol.accepted'), t('plan.rcol.rejected')],
      list.map(function (r) {
        return h('tr', null, td(r.date), td(String(r.round), true), td(String(r.raised), true), td(String(r.refuted), true), td(String(r.kept), true), td(String(r.accepted), true), td(String(r.rejected), true));
      }), [1, 2, 3, 4, 5, 6], 'rounds', t('plan.rounds'));
  }

  function growthCard(g, rounds) {
    var body = g.groups.length ? cap('growth', t('plan.growth'), h('ul', { class: 'list' }, g.groups.map(function (day) {
      return h('li', null, h('strong', { text: day.date }), day.recent ? ' ' + t('plan.new') : '',
        h('ul', { class: 'list nested' }, day.origins.map(function (o) {
          return h('li', null, h('span', { class: 'badge po po-' + o.origin, text: t('plan.origin.' + o.origin) }), ' ' + o.items.map(function (n) { return PM.nodeText(n, S.mask); }).join(' · '));
        })));
    }))) : empty('plan.growthNone');
    return card(t('plan.growth'), h('div', null, body, h('h3', { text: t('plan.rounds') }), roundsTable(rounds || [])));
  }

  function planPage(d, pid) {
    var title = PM.planTitle(d, S.mask);
    var g = PM.growth(d.nodes, Date.now(), PM.GROWTH_DAYS);
    var s = d.summary;
    var root = h('div', null,
      h('p', null, h('a', { href: '#/p/' + encodeURIComponent(pid), text: '← ' + t('plan.back') })),
      h('h1', { text: title }));
    if (d.goal && !S.mask) root.appendChild(h('p', { class: 'muted', text: d.goal }));
    if (d.clarified && !S.mask) d.clarified.forEach((line) => root.appendChild(h('p', { class: 'muted', text: line })));
    root.appendChild(h('div', { class: 'prow big' }, planBar(s.pct, title), h('span', { class: 'pct', text: s.pct + '%' }), h('span', { class: 'muted', text: t('plan.steps', { done: s.done, total: s.total }) }), planCounts(s)));
    if (d.truncated) root.appendChild(h('p', { class: 'err', text: t('plan.truncated') }));
    var props = proposalsCard(d);
    if (props) root.appendChild(props);
    root.appendChild(h('div', { class: 'row' },
      h('button', { type: 'button', 'data-fid': 'pg', 'aria-pressed': S.pgrowth ? 'true' : 'false', onclick: function () { S.pgrowth = !S.pgrowth; store('crew.planGrowth', S.pgrowth ? '1' : '0'); S.last = ''; refresh(true); }, text: t('plan.showGrowth') }),
      h('span', { class: 'muted', text: t('plan.growthHint', { days: PM.GROWTH_DAYS, count: g.recentCount }) })));
    var recent = S.pgrowth ? g.recent : {};
    root.appendChild(card(t('plan.tree'), d.nodes.length ? h('ul', { class: 'ptree root' }, d.nodes.map(function (n) { return planNode(n, pid, d.slug, recent); })) : empty('plan.emptyTree'), '', s.nodes));
    if (S.pgrowth) root.appendChild(growthCard(g, PM.rounds(d)));
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
    var acc = SM.accountText(r, S.mask);
    if (acc) li.appendChild(h('div', { class: 's-where muted', text: t('sessions.account', { who: acc }) }));
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
      h('div', { class: 'card wide' }, d.sessions.length ? cap('sessions', t('nav.sessions'), sessionTree(d.sessions, true, S.sf), 'main') : empty('sessions.none')),
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

  var DET = { id: null, kinds: [], q: '', tl: null, data: null, loading: false, focusKey: null };
  function detReset(id) { DET = { id: id, kinds: [], q: '', tl: SM.emptyTimeline(), data: null, loading: false, focusKey: null }; }
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
      if (el) { try { el.focus(); if (el.type === 'search') el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* ignore */ } }
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
      h('p', null, h('a', { href: d.history ? '#/history' : '#/sessions', text: '← ' + (d.history ? t('nav.history') : t('sessions.back')) })),
      h('h1', { text: title }), top, h('div', { class: 's-meta muted', text: meta.join(' · ') }));
    if (SM.validId(s.parent)) root.appendChild(h('p', null, h('a', { href: '#/s/' + s.parent, text: t('sessions.parent') })));
    var acc = SM.accountText(s, S.mask);
    if (acc) root.appendChild(h('div', { class: 's-meta muted', text: t('sessions.account', { who: acc }) }));
    if (s.task) root.appendChild(h('div', { class: 's-task' }, h('span', { class: 'task-id', text: s.task.id }), v.taskTitle ? ' ' + v.taskTitle : ''));
    var sc = statsCard(d);
    var kids = d.children || [];
    var kidBody = kids.length ? cap('subagents', t('sessions.subagents'), h('ul', { class: 'stree' }, kids.map(function (k) {
      var kv = SM.visible(k, S.mask);
      var li = h('li', { class: 'sess is-sub' },
        h('div', { class: 's-head' }, chip(SM.displayStatus(k)), k.role ? h('span', { class: 'role r-' + k.role, text: t('role.' + (ROLES.indexOf(k.role) >= 0 ? k.role : 'other')) }) : null,
          h('span', { class: 's-meta muted', text: k.agent_type && !S.mask ? k.agent_type : t('sessions.subagent') }),
          h('a', { class: 's-link', href: '#/s/' + k.id, text: t('stats.open') })));
      var line = statsLine(k);
      if (line) li.appendChild(line);
      if (kv.taskTitle) li.appendChild(h('div', { class: 's-task' }, kv.taskTitle));
      return li;
    }))) : null;
    root.appendChild(h('div', { class: 'grid' }, sc, kidBody ? card(t('sessions.subagents'), kidBody, '', kids.length) : null));

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
    // search: only the steps loaded so far; gaps are measured on the whole list, then rows are filtered
    var listBox = h('div', { class: 'tl-box cap main', tabindex: '0', role: 'region', 'aria-label': t('sessions.timeline'), 'data-cap': 'timeline' });
    var countEl = h('p', { class: 'muted tl-count', role: 'status', 'aria-live': 'polite' });
    function drawList() {
      var rows = SM.withGaps(tl.events).filter(function (r) { return SM.stepMatches(r.ev, DET.q, S.mask); });
      listBox.textContent = '';
      listBox.appendChild(rows.length
        ? h('ol', { class: 'tl', 'aria-label': t('sessions.timeline') }, rows.map(stepItem))
        : empty(tl.events.length ? 'sessions.noMatch' : 'sessions.noEvents'));
      var q = DET.q.trim();
      countEl.textContent = q ? t('sessions.searchCount', { shown: rows.length, total: tl.events.length }) + (tl.cursor !== null ? ' ' + t('sessions.searchLoaded') : '') : '';
    }
    var search = h('input', {
      type: 'search', class: 'tl-search', 'data-fid': 'tl-search', value: DET.q, maxlength: 80, autocomplete: 'off',
      'aria-label': t('sessions.search'), placeholder: t('sessions.search'),
      oninput: function (e) { DET.q = e.target.value; drawList(); }
    });
    drawList();
    var note = S.mask ? t('sessions.textPrivate') : d.show_text ? t('sessions.textOn') : t('sessions.tlTextOff');
    root.appendChild(h('section', { class: 'card' }, h('h2', null, t('sessions.timeline'), tl.events.length ? h('span', { class: 'count muted', text: ' · ' + plural('cap.items', tl.events.length) }) : null), h('p', { class: 'muted', text: note }), bar, search, countEl, more, listBox));
    return root;
  }

  var FAMS = ['opus', 'sonnet', 'haiku', 'openai', 'other'];
  // ------------------------------------------------------------------ history (#/history)
  // Pages of past sessions (older ones included), newest first, grouped by day. Each page is one /api/history
  // answer; "load more" appends the next one. A page with rows that are still being counted is fetched again on the
  // refresh tick until the numbers are complete.
  var HIST = { days: 7, project: '', pages: [], projects: [], loaded: false, loading: false, error: null, gen: 0 };
  var HIST_RANGES = [1, 7, 30, 90];

  function histQuery(before) {
    var q = ['days=' + HIST.days, 'tz=' + (-new Date().getTimezoneOffset())];
    if (HIST.project) q.push('project=' + encodeURIComponent(HIST.project));
    if (before !== null && before !== undefined) q.push('before=' + encodeURIComponent(before));
    return '?' + q.join('&');
  }

  function histGet(before) {
    var gen = HIST.gen;
    return api('/api/history' + histQuery(before)).then(function (res) {
      if (gen !== HIST.gen) return null;   // the range or project changed meanwhile
      if (res.status >= 400) throw new Error(res.data.error ? res.data.error.message : 'Error');
      return { before: before === undefined ? null : before, rows: res.data.sessions, totals: res.data.day_totals, next: res.data.next, truncated: !!res.data.truncated, showText: !!res.data.show_text };
    });
  }

  function histReset() { HIST.gen++; HIST.loaded = false; HIST.pages = []; HIST.error = null; HIST.loading = false; S.last = ''; }
  function histSave() { store('crew.historyFilter', JSON.stringify({ days: HIST.days, project: HIST.project })); }

  function histDraw() {
    var sig = 'h' + S.lang + S.mask + HIST.days + HIST.project + HIST.loading + (HIST.error || '') + JSON.stringify(HIST.pages);
    render(historyPage(), sig);
  }

  function histMore() {
    var last = HIST.pages[HIST.pages.length - 1];
    if (HIST.loading || !last || last.next === null) return;
    HIST.loading = true;
    HIST.error = null;
    histDraw();
    var gen = HIST.gen;
    histGet(last.next).then(function (p) {
      if (gen !== HIST.gen) return;
      HIST.loading = false;
      if (p) HIST.pages.push(p);
      histDraw();
    }).catch(function (e) { if (gen !== HIST.gen) return; HIST.loading = false; HIST.error = e.message; histDraw(); });
  }

  // One refresh tick of the history page: first load, else refetch one page whose numbers are still growing, else just redraw.
  function histTick() {
    if (!HIST.loaded) {
      HIST.loaded = true;
      var gen = HIST.gen;
      return Promise.all([histGet(), api('/api/overview')]).then(function (rs) {
        if (gen !== HIST.gen || !rs[0]) return;
        HIST.pages = [rs[0]];
        HIST.projects = rs[1].status < 400 ? rs[1].data.projects.map(function (p) { return { id: p.id, name: p.name }; }) : [];
        histDraw();
      }).catch(function (e) { HIST.loaded = false; render(card(t('error'), h('p', { class: 'err', text: e.message })), 'herr' + S.lang); });
    }
    // board.show_text may have been switched elsewhere: cached rows carry (or lack) text, so start over when it differs
    var gen2 = HIST.gen;
    return api('/api/meta').then(function (res) {
      if (gen2 !== HIST.gen) return null;
      if (res.status < 400 && SM.textChanged(HIST.pages, !!res.data.show_text)) { histReset(); return histTick(); }
      var i = -1;
      HIST.pages.forEach(function (p, k) { if (i < 0 && SM.pagePartial(p)) i = k; });
      if (i < 0) { histDraw(); return null; }
      return histGet(HIST.pages[i].before).then(function (p) {
        if (gen2 !== HIST.gen || !p) return;
        if (SM.textChanged(HIST.pages, p.showText)) { histReset(); return histTick(); }
        HIST.pages[i] = p;
        histDraw();
      });
    }).catch(function () { histDraw(); });
  }

  function dayLabel(day) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
    if (!m) return String(day);
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(S.lang, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  }

  function dayLine(d) {
    if (!d) return null;
    var parts = [plural('history.sessions', d.sessions), SM.fmtDuration(d.duration_ms)];
    if (d.prompts) parts.push(plural('stats.linePrompts', d.prompts));
    if (d.tool_calls) parts.push(plural('stats.lineTools', d.tool_calls));
    if (d.tokens) parts.push(t('stats.lineTokens', { count: SM.compact(d.tokens) }));
    if (d.cost !== null) parts.push(costText(d.cost, d.cost_complete));
    return h('p', { class: 'muted day-total', text: parts.join(' · ') + (d.partial ? ' …' : '') });
  }

  function historyItem(r) {
    var v = SM.visible(r, S.mask);
    var name = (r.engine === 'codex' ? 'Codex' : 'Claude') + (r.model ? ' ' + r.model : '');
    var head = h('div', { class: 's-head' },
      h('span', { class: 's-name', text: name }),
      h('a', { class: 's-link', href: '#/s/' + r.id, text: t('stats.open'), 'aria-label': t('stats.openFor', { name: name }) }),
      h('span', { class: 's-time muted', text: (r.started ? timeText(Date.parse(r.started)) + ' – ' : '') + timeText(Date.parse(r.lastActivity)) }));
    var meta = [];
    if (r.subagent) meta.push(t('sessions.subagent'));
    if (r.project) meta.push(pname({ id: r.project, name: r.project_name || r.project }));
    if (v.folder) meta.push(v.folder);
    if (v.branch) meta.push(v.branch);
    var li = h('li', { class: 'sess' + (r.subagent ? ' is-sub' : '') }, head);
    if (meta.length) li.appendChild(h('div', { class: 's-meta muted', text: meta.join(' · ') }));
    var sl = statsLine(r);
    li.appendChild(sl || h('div', { class: 's-stats muted', text: t('stats.partial') }));
    if (v.title) li.appendChild(h('div', { class: 's-title', text: v.title }));
    if (v.prompt) li.appendChild(h('div', { class: 's-snip' }, h('span', { class: 'muted', text: t('sessions.prompt') + ' ' }), v.prompt));
    return li;
  }

  function historyPage() {
    var pick = function (label, opts, cur, on) {
      return h('label', { class: 'fl' }, h('span', { class: 'muted', text: label }),
        h('select', { 'aria-label': label, onchange: function (e) { on(e.target.value); e.target.blur(); } },
          opts.map(function (o) { return h('option', { value: o[0], selected: String(cur) === String(o[0]), text: o[1] }); })));
    };
    var ranges = HIST_RANGES.map(function (n) { return [n, n === 1 ? t('history.last1') : t('history.lastN', { count: n })]; });
    var popts = [['', t('sessions.allProjects')]];
    HIST.projects.forEach(function (p) { popts.push([p.id, pname(p)]); });
    popts.push(['-', t('sessions.noProject')]);
    var bar = h('div', { class: 'filters', role: 'group', 'aria-label': t('sessions.filters') },
      pick(t('history.range'), ranges, HIST.days, function (v) { HIST.days = HIST_RANGES.indexOf(+v) >= 0 ? +v : 7; histSave(); histReset(); refresh(true); }),
      pick(t('sessions.project'), popts, HIST.project, function (v) { HIST.project = v.slice(0, 40); histSave(); histReset(); refresh(true); }));
    var root = h('div', null, h('h1', { text: t('nav.history') }), bar);
    var groups = SM.historyGroups(HIST.pages);
    if (!groups.length) root.appendChild(h('div', { class: 'card' }, empty('history.none')));
    groups.forEach(function (g) {
      root.appendChild(h('section', { class: 'card wide' }, h('h2', null, dayLabel(g.day), h('span', { class: 'count muted', text: ' · ' + plural('cap.items', g.rows.length) })), dayLine(g.totals), cap('day:' + g.day, dayLabel(g.day), h('ul', { class: 'stree' }, g.rows.map(historyItem)), 'tall')));
    });
    var last = HIST.pages[HIST.pages.length - 1];
    if (last) {
      root.appendChild(last.next !== null
        ? h('p', null, h('button', { type: 'button', class: 'older', 'data-fid': 'more', disabled: HIST.loading, onclick: histMore, text: HIST.loading ? t('sessions.loading') : t('history.more') }))
        : h('p', { class: 'muted', text: t('history.end') }));
      if (HIST.pages.some(function (p) { return p.truncated; })) root.appendChild(h('p', { class: 'muted', text: t('history.truncated') }));
    }
    if (HIST.error) root.appendChild(h('p', { class: 'err', role: 'alert', text: HIST.error }));
    var shown = HIST.pages.length && HIST.pages[0].showText;
    root.appendChild(h('p', { class: 'muted', text: S.mask ? t('sessions.textPrivate') : shown ? t('sessions.textOn') : t('sessions.textOff') }));
    return root;
  }

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
      ? table([t('usage.model'), t('sessions.engine'), t('usage.input'), t('usage.output'), t('usage.cacheWrite'), t('usage.cacheRead'), t('usage.messages'), t('usage.cost')], rows, [2, 3, 4, 5, 6, 7], 'models', t('usage.models'), 'tall') : empty('usage.none'), '', d.models.length));
    root.appendChild(h('details', { class: 'card' }, h('summary', { text: t('usage.table') }),
      table([t('usage.day'), t('usage.tokens')], d.daily.map(function (x) { return h('tr', null, td(x.day), td(num(x.total), true)); }), [1], 'daily', t('usage.table'))));
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

  // ------------------------------------------------------------------ office (an optional add-on, drawn by its office.js)
  // Loads what the add-on lists, one file after another. Whatever fails, the rest of the board keeps working.
  function loadOffice() {
    return api('/api/addons').then(function (res) {
      if (res.status >= 400 || !res.data.office) return;
      S.office = res.data.office;
      if (S.office.state !== 'ok') return;
      S.office.styles.forEach(function (href) { document.head.appendChild(h('link', { rel: 'stylesheet', href: href })); });
      return S.office.scripts.reduce(function (p, src) {
        return p.then(function () {
          return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = reject;
            document.body.appendChild(s);
          });
        });
      }, Promise.resolve());
    }).catch(function () { if (S.office.state === 'ok') S.office.state = 'outdated'; });
  }

  // How to install or update the add-on, or the version that is installed.
  function officeStatus() {
    var o = S.office;
    var commands = function (list) { return list.map(function (c) { return h('p', null, h('code', { text: c })); }); };
    if (o.state === 'ok') return h('div', null, h('p', { text: t('office.optionalIntro') }), h('p', { class: 'muted', text: t('office.installed', { version: o.version || '?' }) }));
    if (o.state === 'outdated') return h('div', null, h('p', { text: t('office.outdated') }), commands(o.update || []));
    return h('div', null, h('p', { text: t('office.optionalIntro') }), h('p', { text: t('office.installHow') }), commands(o.install || []));
  }

  function officePage(d) {
    if (S.office.state !== 'ok' || !window.Office) return h('div', null, h('h1', { text: t('office.title') }), card(t('office.optional'), officeStatus()));
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
    var keep = {};
    var focusKey = act && act.getAttribute ? act.getAttribute('data-cap') : null;
    if (S.lastRoute === S.routeKey) {
      [].forEach.call(main.querySelectorAll('[data-cap]'), function (el) { if (el.scrollTop) keep[el.getAttribute('data-cap')] = el.scrollTop; });
    } else focusKey = null;
    S.last = sig;
    S.lastRoute = S.routeKey;
    main.textContent = '';
    main.appendChild(node);
    [].forEach.call(main.querySelectorAll('[data-cap]'), function (el) {
      var k = el.getAttribute('data-cap');
      if (keep[k]) el.scrollTop = keep[k];
      if (k === focusKey) { try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    });
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
        if (fid) { var el = document.querySelector('[data-fid="' + fid + '"]'); if (el) { try { el.focus(); if (el.type === 'search') el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* ignore */ } } }
      }).then(done, fail);
      return;
    }
    if (r.page === 'plan') {
      api('/api/project/' + encodeURIComponent(r.id) + '/plan/' + encodeURIComponent(r.slug)).then(function (res) {
        if (res.status >= 400) { render(card(t('error'), h('p', { class: 'err', text: res.status === 404 ? t('plan.gone') : (res.data.error ? res.data.error.message : 'Error') })), 'perr' + tag); return; }
        var sig = 'pl' + tag + S.pgrowth + JSON.stringify([res.data, S.pcollapsed]);
        if (S.last === sig) return;
        var fid = document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-fid') : null;
        render(planPage(res.data, r.id), sig);
        if (fid) { var el = document.querySelector('[data-fid="' + fid + '"]'); if (el) { try { el.focus(); } catch (e) { /* ignore */ } } }
      }).then(done, fail);
      return;
    }
    if (r.page !== 'history') HIST.loaded = false;   // coming back reloads the first page
    if (r.page === 'history') {
      if (force) S.last = '';
      histTick().then(done, fail);
      return;
    }
    if (r.page === 'settings' || r.page === 'psettings') {
      if (!force && S.last.indexOf('settings') === 0) { done(); return; }   // do not refresh a form while editing
      var pid = r.page === 'psettings' ? r.id : null;
      Promise.all([api('/api/schema'), api(pid ? '/api/project/' + pid + '/config' : '/api/config')]).then(function (rs) {
        if (rs[1].status >= 400) { render(card(t('error'), h('p', { class: 'err', text: rs[1].data.error.message })), 'settings-err'); return; }
        var schema = pid ? rs[0].data.project : rs[0].data.global;
        var form = settingsPage(schema, rs[1].data, pid, function () { S.last = ''; refresh(true); });
        render(pid ? form : h('div', null, form, card(t('office.optional'), officeStatus())), 'settings' + tag + Date.now());
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
    try { var hf = JSON.parse(store('crew.historyFilter') || '{}'); if (HIST_RANGES.indexOf(hf.days) >= 0) HIST.days = hf.days; if (typeof hf.project === 'string') HIST.project = hf.project.slice(0, 40); } catch (e) { /* defaults */ }
    try { S.pcollapsed = PM.cleanCollapsed(JSON.parse(store('crew.planCollapsed') || '{}')); } catch (e) { S.pcollapsed = {}; }
    S.pgrowth = store('crew.planGrowth') === '1';
    try { var so = JSON.parse(store('crew.sessionOpen') || '{}'); S.sopen = so && typeof so === 'object' && !Array.isArray(so) ? so : {}; } catch (e) { S.sopen = {}; }
    loadTables().then(loadOffice).then(function () {
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
