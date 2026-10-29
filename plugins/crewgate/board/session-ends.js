'use strict';

// Index of "session.end" events (written by the SessionEnd hook) across registered projects:
// session id -> time of the latest end. Each project's events.jsonl is read incrementally and only
// when its size or mtime changed, so asking on every board refresh stays cheap.
const fs = require('fs');

// listFiles() -> array of events.jsonl paths (registered projects only).
function createSessionEnds(listFiles) {
  const files = new Map();   // file -> { size, mtimeMs, offset }
  const ends = new Map();    // session id -> ms of the latest session.end

  function consume(file, state, size) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const len = size - state.offset;
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, state.offset);
      const text = buf.toString('utf8', 0, n);
      const cut = text.lastIndexOf('\n');
      if (cut < 0) return;   // no complete line yet
      state.offset += Buffer.byteLength(text.slice(0, cut + 1));
      for (const line of text.slice(0, cut).split('\n')) {
        if (!line.includes('"session.end"')) continue;
        try {
          const e = JSON.parse(line);
          const ms = Date.parse(e && e.ts);
          if (e && e.type === 'session.end' && typeof e.session === 'string' && e.session && Number.isFinite(ms)) {
            if (!(ends.get(e.session) >= ms)) ends.set(e.session, ms);
          }
        } catch { /* skip a bad line */ }
      }
    } catch { /* unreadable: retry on the next change */ } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
  }

  function refresh() {
    let list = [];
    try { list = listFiles() || []; } catch { /* registry unreadable */ }
    for (const file of list) {
      let st;
      try { st = fs.statSync(file); } catch { files.delete(file); continue; }
      let state = files.get(file);
      if (state && state.size === st.size && state.mtimeMs === st.mtimeMs) continue;
      if (!state || st.size < state.offset) { state = { size: 0, mtimeMs: 0, offset: 0 }; files.set(file, state); }   // new or rewritten file
      state.size = st.size;
      state.mtimeMs = st.mtimeMs;
      consume(file, state, st.size);
    }
  }

  return { refresh, get: (sessionId) => (ends.has(sessionId) ? ends.get(sessionId) : null) };
}

module.exports = { createSessionEnds };
