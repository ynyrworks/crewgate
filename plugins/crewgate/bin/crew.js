#!/usr/bin/env node
'use strict';

// crewgate CLI: crew <group> <action> [options]. Command groups live in lib/commands/<group>.js
// and are loaded on demand, so adding a group needs no change here.
const { main } = require('../lib/core/cli');

// A reader that closes early (`crew ... | head -1`) is not an error of crew: stream errors that mean
// "the reader is gone" are ignored (see lib/core/stream-guard.js); the process still ends with the exit
// code main() returns, so a failure whose output is piped into `head` stays a failure.
require('../lib/core/stream-guard').install([process.stdout, process.stderr]);

main(process.argv.slice(2)).then((c) => {
  process.exitCode = c;
});
