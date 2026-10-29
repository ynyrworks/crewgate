(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UpdateModel = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Pure helpers for the update banner (no DOM): when to show it, how to word the kind of release
  // and when a restarting board counts as back. app.js renders what these return.

  var KINDS = ['patch', 'minor', 'major'];
  var RESTART_LIMIT_MS = 45000;

  // `u` is the answer of GET /api/update, `skipped` the version the user chose to skip (or '').
  function visible(u, skipped) {
    if (!u || u.enabled !== true || typeof u.latest !== 'string' || !u.latest) return false;
    if (KINDS.indexOf(u.kind) < 0) return false;
    return skipped !== u.latest;
  }

  function kindKey(kind) { return 'update.kind.' + (KINDS.indexOf(kind) >= 0 ? kind : 'patch'); }

  // After "Update now" the board goes away and comes back with the new code.
  //   health: the parsed /api/health answer, or null while the board does not answer
  //   -> 'ok' (new version answers), 'wait', or 'timeout' (give up and show the manual command)
  function restartVerdict(oldVersion, health, elapsedMs, limitMs) {
    if (health && health.name === 'crewgate' && typeof health.version === 'string' && health.version !== oldVersion) return 'ok';
    return elapsedMs >= (limitMs || RESTART_LIMIT_MS) ? 'timeout' : 'wait';
  }

  return { visible: visible, kindKey: kindKey, restartVerdict: restartVerdict, RESTART_LIMIT_MS: RESTART_LIMIT_MS };
}));
