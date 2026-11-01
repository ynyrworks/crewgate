'use strict';

// The plan controls (plan.interview, plan.enforce, plan.review) can be edited by the model along with the rest of the
// config file. sync() compares them with the values stored last time and records one config.changed event per key.
// One small file is read and written; nothing is spawned. It never throws.
const fs = require('fs');
const path = require('path');
const events = require('../core/events');
const json = require('../core/json');
const paths = require('../core/paths');

const KEYS = ['interview', 'enforce', 'review'];
const file = (pid) => path.join(paths.projectDir(pid), 'plan-settings.json');
const val = (v) => (typeof v === 'string' ? v.slice(0, 40) : null);

function current(cfg) {
  const p = cfg && typeof cfg.plan === 'object' && cfg.plan ? cfg.plan : {};
  const out = {};
  for (const k of KEYS) out[k] = val(p[k]);
  return out;
}

function stored(pid) {
  try {
    const r = json.readJson(file(pid), {});
    if (r.status !== 'ok' || !r.data || typeof r.data !== 'object') return null;
    const out = {};
    for (const k of KEYS) { if (typeof r.data[k] !== 'string') return null; out[k] = r.data[k]; }
    return out;
  } catch { return null; }
}

// Nothing (or something unreadable) stored: store the current values and record nothing.
function sync(pid, cfg, src) {
  try {
    const now = current(cfg);
    if (KEYS.some((k) => now[k] === null)) return [];
    const old = stored(pid);
    const changed = old ? KEYS.filter((k) => old[k] !== now[k]) : [];
    if (old && !changed.length) return [];
    fs.mkdirSync(paths.projectDir(pid), { recursive: true });
    json.save(file(pid), now);
    for (const k of changed) {
      try {
        events.append(pid, {
          type: 'config.changed', src, data: { file: '.claude/crew.json', key: `plan.${k}`, from: old[k], to: now[k] },
          key: `plan-settings:${k}:${Date.now()}:${Math.random()}`,
        });
      } catch { /* the stored value is already updated; the record is best effort */ }
    }
    return changed;
  } catch { return []; }
}

module.exports = { sync, KEYS };
