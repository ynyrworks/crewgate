#!/usr/bin/env node
'use strict';

// crewgate CLI: crew <group> <action> [options]. Command groups live in lib/commands/<group>.js
// and are loaded on demand, so adding a group needs no change here.
const { main } = require('../lib/core/cli');

// A reader that closes early (`crew ... | head -1`) is not an error of crew: an EPIPE on stdout or
// stderr ends the process quietly with the exit code the command had.
let code = 0;
for (const s of [process.stdout, process.stderr]) {
  s.on('error', (e) => {
    if (e && e.code === 'EPIPE') process.exit(code);
    throw e;
  });
}

main(process.argv.slice(2)).then((c) => {
  code = c;
  process.exitCode = c;
});
