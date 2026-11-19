#!/usr/bin/env node
'use strict';

// crewgate CLI: crew <group> <action> [options]. Command groups live in lib/commands/<group>.js
// and are loaded on demand, so adding a group needs no change here.
const { main } = require('../lib/core/cli');

// A reader that closes early (`crew ... | head -1`) is not an error of crew: an EPIPE on stdout or
// stderr stops further writing quietly; the process still ends with the exit code main() returns,
// so a failure whose output is piped into `head` stays a failure.
let closed = false;
for (const s of [process.stdout, process.stderr]) {
  s.on('error', (e) => {
    if (e && e.code === 'EPIPE') { closed = true; return; }
    if (closed && e && e.code === 'ERR_STREAM_DESTROYED') return;
    throw e;
  });
}

main(process.argv.slice(2)).then((c) => {
  process.exitCode = c;
});
