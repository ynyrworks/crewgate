#!/usr/bin/env node
'use strict';

// crewgate CLI: crew <group> <action> [options]. Command groups live in lib/commands/<group>.js
// and are loaded on demand, so adding a group needs no change here.
const { main } = require('../lib/core/cli');

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
