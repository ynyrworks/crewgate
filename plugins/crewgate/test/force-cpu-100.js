'use strict';

// Test-only preload (node --require, through NODE_OPTIONS so spawned hooks get it too): every CPU sample reports 100%.
// Proves that a test is not at the mercy of the machine's load: run the suite with it and only the tests about the
// load check itself may fail. Not a test file, and nothing in production reads it.
require('../lib/hooks/machineload').setSampler(() => 100);
