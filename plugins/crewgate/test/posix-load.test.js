'use strict';

// A probe of what macOS and Linux can do about load. It measures and reports with t.diagnostic under the
// prefix POSIX-FACT (read the lines in the CI log). It asserts only that a child inherits the parent's
// priority, which Crewgate already relies on. A missing tool or a failed call is reported, never a failure.
// Skips on Windows. Touches only processes it starts. Saturation: at most half the cores, about 4.5 s, once.

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const POSIX = process.platform !== 'win32';
const LIMIT = 5000;   // ms, every tool call

const run = (cmd, args, ms, env) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: ms || LIMIT, stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env });
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim().replace(/\s+/g, ' ').slice(0, 300);
  const state = r.error ? `error=${r.error.code || r.error.message}` : `exit=${r.status}${r.signal ? ' signal=' + r.signal : ''}`;
  return { ok: !r.error && r.status === 0, state, text, out: (r.stdout || '').trim() };
};
const have = (name) => run('sh', ['-c', `command -v ${name}`]).ok;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const kill = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };

// Runs in a child: lowers itself to `target`, then asks bash to start children that print their own nice value.
const INHERIT = `
const os = require('os');
const { spawnSync } = require('child_process');
os.setPriority(0, Number(process.env.TARGET));
const sh = (script) => {
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 4000 });
  return r.error ? 'error=' + r.error.code : (r.stdout || '').trim().replace(/\\s+/g, ' ');
};
const one = '"$N" -e "$P"';
console.log(JSON.stringify({
  self: os.getPriority(),
  direct: sh(one),
  amp: sh(one + ' & wait'),
  nested: sh('bash -c \\'' + one + ' & wait\\' & wait'),
}));
`;
const PRIO = 'process.stdout.write(String(require("os").getPriority()))';

test('POSIX load probe', { skip: !POSIX && 'POSIX only' }, async (t) => {
  const fact = (msg) => t.diagnostic(`POSIX-FACT ${msg}`);
  const cores = os.cpus().length;
  const base = os.getPriority(process.pid);
  fact(`platform=${process.platform} arch=${process.arch} node=${process.versions.node} cores=${cores} runner-nice=${base}`);
  const started = [];   // pids of every long-lived child we start; all killed at the end

  try {
    // 1. Inheritance (asserted). A child sets itself to at least nice 10, then its children report their nice value.
    {
      const target = Math.max(base, 10);
      const env = Object.assign({}, process.env, { TARGET: String(target), N: process.execPath, P: PRIO });
      const r = run(process.execPath, ['-e', INHERIT], 15000, env);
      fact(`inherit target=${target} ${r.state} ${r.text}`);
      let got = null;
      try { got = JSON.parse(r.out); } catch { /* reported above */ }
      if (got && /^-?\d+$/.test(String(got.direct))) {
        assert.strictEqual(got.self, target);
        assert.strictEqual(Number(got.direct), target, 'child through bash -c inherits the priority');
        assert.strictEqual(Number(got.amp), target, 'child started with & inherits the priority');
        if (/^-?\d+$/.test(String(got.nested))) assert.strictEqual(Number(got.nested), target, 'nested bash -c with & inherits');
      } else {
        fact('inherit not asserted: bash missing or the probe failed');
      }
    }

    // 2. Saturation: spinners at the runner's priority and at +10 (nice cannot go below the runner's own value).
    // Pinned to cpu 0 with taskset where it exists, else unpinned at half the cores. The spinners (2 s each, ending
    // by themselves) outlast the probe's 1 s window; each phase reports whether the window ended before they did.
    {
      const n = Math.floor(cores / 2);
      const pin = have('taskset');
      const mode = pin ? 'pinned' : 'unpinned';
      fact(`saturation mode=${mode} spinners=${n} (half of ${cores} cores) taskset=${pin ? 'present' : 'absent'}`);
      if (n < 1) {
        fact('saturation not run: fewer than 2 cores');
      } else {
        const spin = 'const e=Date.now()+2000;while(Date.now()<e){}console.log(Date.now())';
        const probe = 'const t0=Date.now();let last=t0,max=0;const iv=setInterval(()=>{const n=Date.now();if(n-last>max)max=n-last;last=n;if(n-t0>=1000){clearInterval(iv);console.log(max-5+" "+n)}},5)';
        const phase = async (extraNice) => {
          const wrap = (args, nice) => {
            const cmd = [...(nice ? ['nice', '-n', String(nice)] : []), process.execPath, ...args];
            return pin ? ['taskset', ['-c', '0', ...cmd]] : [cmd[0], cmd.slice(1)];
          };
          const outs = [];
          const go = (args, nice, slot) => {
            const [c, a] = wrap(args, nice);
            const p = spawn(c, a, { stdio: ['ignore', 'pipe', 'ignore'] });
            outs[slot] = '';
            p.stdout.on('data', (d) => { outs[slot] += d; });
            p.on('error', () => {});
            return p;
          };
          const kids = [];
          for (let i = 0; i < n; i++) kids.push(go(['-e', spin], extraNice, i + 1));
          await sleep(150);
          const p = go(['-e', probe], 0, 0);
          const all = [...kids, p].map((c) => new Promise((res) => { c.on('error', () => res()); c.on('close', () => res()); }));
          const guard = setTimeout(() => [...kids, p].forEach((c) => c.pid && kill(c.pid)), 4000);
          await Promise.all(all);
          clearTimeout(guard);
          const [delay, probeEnd] = String(outs[0]).trim().split(' ').map(Number);
          const spinEnds = outs.slice(1).map((s) => Number(String(s).trim())).filter((x) => x > 0);
          const outlasted = probeEnd > 0 && spinEnds.length > 0 ? probeEnd < Math.min(...spinEnds) : null;
          return { delay: Number.isFinite(delay) ? delay : null, outlasted, spinners: spinEnds.length };
        };
        try {
          const same = await phase(0);
          const low = await phase(10);
          const show = (r) => `${r.delay === null ? 'no output' : r.delay} (probe window ended before the spinners: ${r.outlasted === null ? 'unknown' : r.outlasted}; spinners reporting ${r.spinners}/${n})`;
          fact(`saturation ${mode}, ${n} spinners + 1 probe: probe worst delay ms with spinners at nice ${base}: ${show(same)}; at nice ${base + 10}: ${show(low)}`);
          if (same.delay === null || low.delay === null) fact('saturation result missing: a process failed or taskset refused cpu 0');
          else if (pin) fact('saturation reading: only cpu 0 is saturated, the other cores stay free, so a difference holds for that core alone');
          else fact('saturation reading: unpinned, half the cores may not saturate the machine, so a small difference shows nothing');
        } catch (e) { fact(`saturation failed: ${e.message}`); }
      }
    }

    // 3. Linux: systemd and cgroups.
    if (process.platform === 'linux') {
      const sd = have('systemd-run');
      fact(`linux systemd-run=${sd ? 'present' : 'absent'}`);
      if (sd) {
        const v = run('systemd-run', ['--version']);
        fact(`linux systemd-run --version ${v.state} ${v.text.slice(0, 80)}`);
        const sc = run('systemd-run', ['--user', '--scope', '--quiet', '--', 'true']);
        fact(`linux systemd-run --user --scope true ${sc.state} ${sc.text}`);
      }
      const bc = have('busctl') ? run('busctl', ['--user', 'status']) : null;
      fact(`linux busctl --user status ${bc ? bc.state + ' ' + bc.text.slice(0, 120) : 'busctl absent'}`);
      let cg = '';
      try { cg = fs.readFileSync('/proc/self/cgroup', 'utf8').trim(); } catch (e) { fact(`linux /proc/self/cgroup unreadable ${e.code}`); }
      if (cg) {
        fact(`linux /proc/self/cgroup ${cg.replace(/\n/g, ' | ').slice(0, 300)}`);
        const line = cg.split('\n').find((l) => l.startsWith('0::'));
        const dir = '/sys/fs/cgroup' + (line ? line.slice(3) : '');
        for (const [what, f] of [['dir', dir], ['cgroup.procs', dir + '/cgroup.procs']]) {
          let w = 'yes';
          try { fs.accessSync(f, fs.constants.W_OK); } catch (e) { w = `no (${e.code})`; }
          fact(`linux cgroup ${what} writable=${w} ${f}`);
        }
      }
      // Move only a sleeping child we started, into a transient scope with a quota.
      if (sd) {
        const c = spawn('sleep', ['30'], { stdio: 'ignore' });
        c.on('error', () => {});
        if (c.pid) {
          started.push(c.pid);
          const before = run('cat', [`/proc/${c.pid}/cgroup`]);
          const mv = run('systemd-run', ['--user', '--scope', '--quiet', '--collect', '-p', `PIDs=${c.pid}`, '-p', 'CPUQuota=50%', '--', 'true']);
          const after = run('cat', [`/proc/${c.pid}/cgroup`]);
          fact(`linux scope PIDs=<sleeping child> CPUQuota=50% ${mv.state} ${mv.text}`);
          fact(`linux child cgroup before: ${before.text} after: ${after.text} moved=${before.out !== after.out}`);
        }
      }
    }

    // 4. macOS: taskpolicy.
    if (process.platform === 'darwin') {
      const tp = have('taskpolicy');
      fact(`macos taskpolicy=${tp ? 'present' : 'absent'}`);
      if (tp) {
        const ps = (pid) => run('ps', ['-o', 'pri=,nice=,stat=', '-p', String(pid)]).text;
        const ctl = spawn('sleep', ['30'], { stdio: 'ignore' });
        ctl.on('error', () => {});
        // A parent that waits 2 s, then starts a sleeping child and prints its pid.
        const par = spawn('sh', ['-c', 'sleep 2; sleep 30 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
        par.on('error', () => {});
        if (ctl.pid && par.pid) {
          started.push(ctl.pid, par.pid);
          let line = '';
          par.stdout.on('data', (d) => { line += d; });
          const b = ps(par.pid);
          const r = run('taskpolicy', ['-b', '-p', String(par.pid)]);
          fact(`macos taskpolicy -b -p <sleeping parent> ${r.state} ${r.text} (uid=${process.getuid && process.getuid()})`);
          fact(`macos parent ps pri,nice,stat before: ${b} after: ${ps(par.pid)}`);
          for (let i = 0; i < 40 && !/\d/.test(line); i++) await sleep(100);
          const gc = parseInt(line, 10);
          if (gc > 0) {
            started.push(gc);
            fact(`macos child started after the downgrade ps: ${ps(gc)}; control child started before it ps: ${ps(ctl.pid)}`);
            const q = run('taskpolicy', ['-g', '-p', String(gc)]);
            fact(`macos taskpolicy -g -p <child> ${q.state} ${q.text}`);
          } else {
            fact('macos grandchild pid not read in 4 s');
          }
        }
      }
    }
  } catch (e) {
    if (e && e.code === 'ERR_ASSERTION') throw e;
    fact(`probe stopped by an error: ${e && e.message}`);
  } finally {
    started.forEach(kill);
  }
});
