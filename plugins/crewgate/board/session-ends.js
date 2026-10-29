'use strict';

// Index of crewgate events across registered projects, read incrementally from each project's
// events.jsonl and only when its size or mtime changed, so asking on every board refresh stays cheap.
//   session.end      -> session id -> time of the latest end (SessionEnd hook)
//   task.dispatched  -> sessions that dispatched tasks (the orchestrators)
//   subagent.start/stop -> agent id -> { task, type, session } (links a subagent transcript to a task)
const fs = require('fs');

// listFiles() -> array of events.jsonl paths (registered projects only).
function createSessionEnds(listFiles) {
  const files = new Map();   // file -> { size, mtimeMs, offset }
  const ends = new Map();    // session id -> ms of the latest session.end
  const agents = new Map();  // agent id -> { task, type, session }
  const dispatchers = new Set();   // session ids that dispatched a task

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
        if (!/"(?:session.end|task.dispatched|subagent.(?:start|stop))"/.test(line)) continue;
        try {
          const e = JSON.parse(line);
          if (!e || typeof e.type !== 'string') continue;
          const ms = Date.parse(e.ts);
          const sid = typeof e.session === 'string' && e.session ? e.session : null;
          if (e.type === 'session.end' && sid && Number.isFinite(ms)) {
            if (!(ends.get(sid) >= ms)) ends.set(sid, ms);
          } else if (e.type === 'task.dispatched' && sid) {
            dispatchers.add(sid);
          } else if ((e.type === 'subagent.start' || e.type === 'subagent.stop') && typeof e.agent === 'string' && e.agent) {
            const prev = agents.get(e.agent) || { task: null, type: null, session: null };
            const d = e.data && typeof e.data === 'object' ? e.data : {};
            agents.set(e.agent, {
              task: (typeof e.task === 'string' && e.task) || prev.task,
              type: (typeof d.agent_type === 'string' && d.agent_type) || prev.type,
              session: sid || prev.session,
            });
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

  return {
    refresh,
    get: (sessionId) => (ends.has(sessionId) ? ends.get(sessionId) : null),
    agent: (agentId) => agents.get(agentId) || null,
    dispatched: (sessionId) => dispatchers.has(sessionId),
  };
}

module.exports = { createSessionEnds };
