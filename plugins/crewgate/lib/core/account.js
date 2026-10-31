'use strict';

// Which Claude account a session runs under. Never throws: missing or malformed data gives "unknown".
// Sources: CLAUDE_CODE_ACCOUNT_UUID / CLAUDE_CODE_ORGANIZATION_UUID (the hook's environment), then `oauthAccount`
// in <CLAUDE_CONFIG_DIR or home>/.claude.json for the label and plan. Events carry only the short id and the plan;
// the label (email, organization) lives in <home>/accounts.json, which stays on this machine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('./paths');
const json = require('./json');

const SHORT = 8;
const LABEL_MAX = 120;
const MAX_FILE_BYTES = 8 * 1024 * 1024;   // ~/.claude.json can be large; a bigger file is not read

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, n = LABEL_MAX) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');
const uuidOf = (v) => (typeof v === 'string' && /^[0-9A-Za-z-]{8,64}$/.test(v.trim()) ? v.trim().toLowerCase() : '');
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

function claudeJson(env) {
  const dir = text(env.CLAUDE_CONFIG_DIR, 1000);
  return path.join(dir ? path.resolve(dir) : os.homedir(), '.claude.json');
}

// oauthAccount of the config file, or null (missing, too big, malformed, wrong shape).
function readOauth(env) {
  try {
    const file = claudeJson(env);
    if (fs.statSync(file).size > MAX_FILE_BYTES) return null;
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const o = JSON.parse(raw).oauthAccount;
    return isObj(o) ? o : null;
  } catch { return null; }
}

// current(env) -> null (nothing known) or { uuid, id, plan, label: { email, organization } | null }
function current(env = process.env) {
  try {
    const envUuid = uuidOf(env.CLAUDE_CODE_ACCOUNT_UUID);
    const envOrg = uuidOf(env.CLAUDE_CODE_ORGANIZATION_UUID);
    if (!envUuid && text(env.ANTHROPIC_API_KEY, 10)) return null;   // an API key bills the key, not an account
    const o = readOauth(env);
    const fileUuid = o ? uuidOf(o.accountUuid) : '';
    const fileOrg = o ? uuidOf(o.organizationUuid) : '';
    let uuid = envUuid;
    let useFile = !!o;
    if (envUuid) {
      // the file describes another account when either id from the environment differs from it
      if (!fileUuid || !same(envUuid, fileUuid) || (envOrg && fileOrg && !same(envOrg, fileOrg))) useFile = false;
    } else {
      uuid = fileUuid;
      if (!uuid) return null;
    }
    const orgUuid = envOrg || (useFile ? fileOrg : '');
    const out = { uuid, id: uuid.slice(0, SHORT), orgUuid, plan: '', label: null };
    if (useFile) {
      out.plan = text(o.billingType, 40) || text(o.seatTier, 40);
      const email = text(o.emailAddress);
      const organization = text(o.organizationName);
      if (email || organization) out.label = { email, organization };
    }
    return out;
  } catch { return null; }
}

// matches(acct, expected) -> true | false | null (null: the account is unknown, so it cannot be judged)
function matches(acct, expected) {
  const want = text(expected);
  if (!want) return true;
  if (!acct) return null;
  const l = acct.label || {};
  const cands = [acct.uuid, acct.id, acct.orgUuid, l.email, l.organization].filter(Boolean);
  if (!cands.length) return null;
  return cands.some((c) => same(c, want));
}

const labelsFile = () => path.join(paths.home(), 'accounts.json');

// Remember the label of a short id (written only when it changed). Never throws.
function remember(acct) {
  if (!acct || !acct.label) return;
  try {
    const cur = json.readJson(labelsFile(), {}).data;
    const old = isObj(cur) && isObj(cur[acct.id]) ? cur[acct.id] : {};
    if (old.email === acct.label.email && old.organization === acct.label.organization) return;
    json.update(labelsFile(), {}, (d) => {
      d[acct.id] = { email: acct.label.email, organization: acct.label.organization };
      return d;
    }, () => {});
  } catch { /* the label is a convenience */ }
}

// labels() -> { <short id>: { email, organization } } (an empty object when the file is missing or malformed)
function labels() {
  const out = Object.create(null);
  try {
    const d = json.readJson(labelsFile(), {}).data;
    if (!isObj(d)) return out;
    for (const [id, l] of Object.entries(d)) {
      if (!/^[0-9A-Za-z-]{1,16}$/.test(id) || !isObj(l)) continue;
      const email = text(l.email);
      const organization = text(l.organization);
      if (email || organization) out[id] = { email, organization };
    }
  } catch { /* none */ }
  return out;
}

// label(id) -> { email, organization } | null
function label(id) { return labels()[id] || null; }

module.exports = { current, matches, remember, label, labels, SHORT };
