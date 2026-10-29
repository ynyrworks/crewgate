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

  // ------------------------------------------------------------------ routing
  function parseRoute() {
    var p = (location.hash || '#/').replace(/^#/, '').split('/').filter(Boolean);
    if (!p.length) return { page: 'overview' };
    if (p[0] === 'p' && p[1]) return p[2] === 'settings' ? { page: 'psettings', id: p[1] } : { page: 'project', id: p[1] };
    if (['sessions', 'usage', 'settings'].indexOf(p[0]) >= 0) return { page: p[0] };
    return { page: 'overview' };
  }

  function renderChrome() {
    document.documentElement.lang = S.lang;
    document.title = 'crewgate – ' + t('title');
    $('skip').textContent = t('skip');
    $('nav').setAttribute('aria-label', t('nav'));
    var page = S.route.page;
    var items = [['overview', '#/', t('nav.overview')], ['sessions', '#/sessions', t('nav.sessions')], ['usage', '#/usage', t('nav.usage')], ['settings', '#/settings', t('nav.settings')]];
    var nav = $('nav');
    nav.textContent = '';
    items.forEach(function (it) {
      var cur = it[0] === page || (it[0] === 'overview' && (page === 'project' || page === 'psettings'));
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
    var path = r.page === 'overview' ? '/api/overview' : r.page === 'project' ? '/api/project/' + encodeURIComponent(r.id) : r.page === 'sessions' ? '/api/sessions' : '/api/usage';
    api(path).then(function (res) {
      if (res.status >= 400) { render(card(t('error'), h('p', { class: 'err', text: res.data.error ? res.data.error.message : 'Error' })), 'err' + tag); return; }
      var d = res.data;
      var node = r.page === 'overview' ? overviewPage(d) : r.page === 'project' ? projectPage(d) : r.page === 'sessions' ? sessionsPage(d) : usagePage(d);
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
      refresh(true);
      startTimer();
    });
  }
  boot();
}());
