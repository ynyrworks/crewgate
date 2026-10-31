'use strict';

// Whole-machine CPU load for the worker dispatch check (limits.dispatch_max_cpu).
// sample(): two os.cpus() readings SAMPLE_MS apart -> busy percent (0-100). The wait is one Atomics.wait (no busy
// loop), so the hook is idle while it waits. Cost: about 200 ms per worker dispatch when the machine is under the
// limit, about 400 ms when the first sample is over (a second one is taken); the hook budget is 5 s (timeouts.js).
const os = require('os');

const SAMPLE_MS = 200;

function read() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function sample(ms = SAMPLE_MS) {
  const a = read();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const b = read();
  const total = b.total - a.total;
  if (!(total > 0)) throw new Error('no cpu time elapsed');
  return Math.min(100, Math.max(0, Math.round((100 * (total - (b.idle - a.idle))) / total)));
}

let sampler = sample;
function setSampler(fn) { sampler = fn || sample; } // tests only

// -> { pct } when the machine is busier than `limit` in two samples in a row, else null. A spike seen once is not
// enough, and any failure of the sampler lets the dispatch through. limit 100 (or not a number) is off: no sample.
function overLimit(limit) {
  if (!(limit < 100) || !(limit >= 0)) return null;
  if (process.env.CREWGATE_CPU_CHECK === 'off') return null; // set by the hook test helper: a busy test machine must not deny
  try {
    const first = sampler();
    if (!(first > limit)) return null;
    const second = sampler();
    return second > limit ? { pct: second } : null;
  } catch { return null; }
}

module.exports = { sample, setSampler, overLimit, SAMPLE_MS };
