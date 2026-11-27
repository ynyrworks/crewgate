'use strict';
// Ports for tests that hand a port number to ANOTHER process (a spawned board, a `crew` command).
//
// freePort() binds port 0, reads the number and closes the socket. Between that close and the other process's own
// bind, anything on the machine can take the number, so a number from freePort() is never trusted on its own:
// withFreePort() runs the whole attempt and, only when the evidence says "the port was taken by someone else",
// tries again with a new port (at most `attempts` times). Any other failure is thrown at once.
//
// freePort() used directly is safe only where no process binds the port (the number is only written into a file
// or probed); the call site says so in a comment.
const net = require('node:net');

const ATTEMPTS = 4;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// Does the text show that `port` was already taken when something tried to bind it? The board's own message is
// "Port N is already in use."; a raw bind error says EADDRINUSE and names the port.
function takenIn(text, port) {
  const t = String(text || '');
  return new RegExp(`Port ${port} is already in use`).test(t) || new RegExp(`EADDRINUSE[^\\n]*[:\\s]${port}\\b`).test(t);
}

// An Error that carries the evidence; withFreePort retries on it.
function takenError(port, detail) {
  const e = new Error(`port ${port} was taken by someone else before the board bound it (Port ${port} is already in use)\n${detail || ''}`);
  e.portTaken = port;
  return e;
}

// run(port, attempt) does one complete attempt on `port`. cleanup(port, attempt) (optional) undoes what a failed
// attempt left (stop a board, remove state files) before the next one. `pick` is only replaced by the helper's own test.
async function withFreePort(run, { attempts = ATTEMPTS, pick = freePort, cleanup } = {}) {
  for (let attempt = 1; ; attempt++) {
    const port = await pick();
    try { return await run(port, attempt); } catch (e) {
      const taken = e && (e.portTaken === port || takenIn(e.message, port));
      if (!taken || attempt >= attempts) throw e;
      if (cleanup) await cleanup(port, attempt);
    }
  }
}

// Collects what a spawned child writes to stderr (spawn it with stdio ['ignore','ignore','pipe']) and when it exits.
function watchChild(child) {
  const w = { stderr: '', exited: false, code: null };
  child.stderr.on('data', (d) => { w.stderr += d; });
  w.done = new Promise((resolve) => child.on('exit', (code) => { w.exited = true; w.code = code; resolve(code); }));
  return w;
}

module.exports = { freePort, takenIn, takenError, withFreePort, watchChild, ATTEMPTS };
