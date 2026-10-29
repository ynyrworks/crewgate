'use strict';

// Agent names. Claude Code reports a plugin's agent as "crewgate:crew-reviewer" but a project copy in
// .claude/agents/ as plain "crew-reviewer"; both mean the same role. One helper, used by hooks, the
// board watcher and the event writers, so the two spellings never diverge again.
const ROLE_BY_TYPE = {
  'crew-worker': 'worker', worker: 'worker',
  'crew-reviewer': 'reviewer', reviewer: 'reviewer',
  'crew-refuter': 'refuter', refuter: 'refuter',
};

// "crewgate:Crew-Reviewer" -> "crew-reviewer". Empty input gives `fallback` (default 'general-purpose').
function bareName(type, fallback = 'general-purpose') {
  const s = String(type === undefined || type === null ? '' : type).trim();
  if (!s) return fallback;
  return s.split(':').pop().toLowerCase() || fallback;
}

// worker | reviewer | refuter | other
function roleOf(type) {
  return ROLE_BY_TYPE[bareName(type, '')] || 'other';
}

// Event data fields for an agent type: the bare name plus, when it differed, the original spelling.
function typeFields(raw, max = 80) {
  const r = String(raw === undefined || raw === null ? '' : raw).trim().slice(0, max);
  return { agent_type: bareName(r), agent_type_raw: r || null };
}

module.exports = { bareName, roleOf, typeFields, ROLE_BY_TYPE };
