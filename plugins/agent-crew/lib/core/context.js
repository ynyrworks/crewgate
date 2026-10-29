'use strict';

// Who is calling? Works for hook payloads (with agent_id inside subagents) and plain CLI calls.
const project = require('./project');

// resolve(payload?, cwd?) -> {
//   cwd, isSubagent, isMainWorktree, projectRoot, projectId, registered, project }
// payload.cwd wins over the cwd argument. A call without an agent_id is the main thread.
// Never throws: outside git, or with git missing, isMainWorktree is true and projectRoot may be null.
function resolve(payload, cwd) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const dir = (typeof p.cwd === 'string' && p.cwd) || cwd || process.cwd();
  const isSubagent = typeof p.agent_id === 'string' ? p.agent_id !== '' : !!p.agent_id;
  let info = { root: null, linked: false };
  try { info = project.inspect(dir); } catch { /* keep defaults */ }
  let registered = null;
  let projectId = null;
  if (info.root) {
    projectId = project.projectId(info.root);
    try { registered = project.list().find((x) => x.id === projectId) || null; } catch { /* unreadable registry */ }
  } else {
    try { registered = project.findByCwd(dir); } catch { /* ignore */ }
    if (registered) projectId = registered.id;
  }
  return {
    cwd: dir,
    isSubagent,
    isMainWorktree: !info.linked,
    projectRoot: info.root || (registered ? registered.path : null),
    projectId,
    registered: !!registered,
    project: registered,
  };
}

module.exports = { resolve };
