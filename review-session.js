/**
 * Server-side store for "review before posting" sessions.
 *
 * The Create flow now generates content, hands it to the web UI for editing, and only posts to
 * Jira when the QA engineer hits Submit. Between those steps the heavy generation context
 * (Confluence page bodies, Figma text, related issues, the format reference) has to survive, but
 * it must NOT travel to the browser and back on every keystroke — it is large and the browser has
 * no use for it. So the browser only ever holds the editable payload plus a session id, and the
 * full envelope stays here on disk next to the project.
 *
 * Sessions are disposable: pruned by age on every write, and deleted after a successful submit.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SESSIONS_DIR_NAME = ".review-sessions";
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Session ids come from the browser, so anything that is not a plain UUID is rejected outright. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sessionsDir(projectDir) {
  return path.join(projectDir, SESSIONS_DIR_NAME);
}

function assertValidId(sessionId) {
  const id = String(sessionId || "");
  if (!SESSION_ID_RE.test(id)) {
    throw new Error("Invalid review session id");
  }
  return id;
}

function sessionPath(projectDir, sessionId) {
  return path.join(sessionsDir(projectDir), `${assertValidId(sessionId)}.json`);
}

/** Drop sessions older than maxAgeMs. Never throws — pruning must not break a real request. */
function pruneSessions(projectDir, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const dir = sessionsDir(projectDir);
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed += 1;
      }
    } catch {
      /* concurrent removal — ignore */
    }
  }
  return removed;
}

/**
 * @param {string} projectDir
 * @param {Object} envelope - full generation envelope (payload + context)
 * @returns {string} the new session id
 */
function createSession(projectDir, envelope) {
  const dir = sessionsDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  pruneSessions(projectDir);
  const sessionId = crypto.randomUUID();
  fs.writeFileSync(
    path.join(dir, `${sessionId}.json`),
    JSON.stringify({ ...envelope, sessionId, createdAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
  return sessionId;
}

function readSession(projectDir, sessionId) {
  const file = sessionPath(projectDir, sessionId);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error("Review session not found or expired — generate again");
  }
  return JSON.parse(raw);
}

function writeSession(projectDir, sessionId, envelope) {
  const file = sessionPath(projectDir, sessionId);
  fs.writeFileSync(
    file,
    JSON.stringify({ ...envelope, sessionId, updatedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

function deleteSession(projectDir, sessionId) {
  try {
    fs.unlinkSync(sessionPath(projectDir, sessionId));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  SESSIONS_DIR_NAME,
  createSession,
  readSession,
  writeSession,
  deleteSession,
  pruneSessions,
  sessionPath,
};
