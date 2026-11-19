'use strict';

// Error handler for process.stdout / process.stderr of the CLI. A reader that is gone is not an
// error of crew: the process keeps the exit code main() returns. Any other stream error is rethrown.
// Codes that mean "the reader is gone" (the list is explicit; do not widen it to every error):
//  - EPIPE: write to a pipe or socket whose reader closed (Linux, Windows, macOS).
//  - EPROTOTYPE: macOS returns it instead of EPIPE when a write hits a socket pair whose peer is
//    being torn down (stdio of a spawned child is a socket pair on Unix).
//  - ECONNRESET: the peer of the socket pair reset the connection instead of closing it cleanly.
//  - ERR_STREAM_DESTROYED: the stream was already destroyed by an earlier error; it can arrive
//    first, before any of the codes above was seen, so it is accepted on its own.
const READER_GONE = new Set(['EPIPE', 'EPROTOTYPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED']);

// Test-only evidence: with CREWGATE_TEST=1 and CREWGATE_STREAM_ERROR_LOG=<file>, the code of each
// stream error seen is appended to that file (the closed pipes cannot carry it).
function record(e) {
  if (process.env.CREWGATE_TEST !== '1' || !process.env.CREWGATE_STREAM_ERROR_LOG) return;
  try {
    require('node:fs').appendFileSync(process.env.CREWGATE_STREAM_ERROR_LOG, `${(e && e.code) || (e && e.message) || String(e)}\n`);
  } catch { /* evidence only */ }
}

function handleStreamError(e) {
  record(e);
  if (e && READER_GONE.has(e.code)) return;
  throw e;
}

function install(streams) {
  for (const s of streams) s.on('error', handleStreamError);
}

module.exports = { handleStreamError, install, READER_GONE };
