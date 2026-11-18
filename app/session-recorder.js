import {
  sessionId,
  sessionPath,
  serializeSession,
  writeSession,
  listSessions,
  loadSession,
  latestSession,
  describeSession,
  SESSION_DIR,
} from '../utils/session-store.js';

/**
 * Keeps the conversation being had on disk (task.md item 3).
 *
 * The recorder owns the *current* session: its id, when it started and the
 * model it is talking to. `save(chunks)` snapshots the live context window —
 * every chunk, verbatim — into `agent/sessions/<date>.json`, so a conversation
 * can be listed, inspected and picked up again later (`/sessions`).
 *
 * It is deliberately dumb about *when* to save: the host loop calls `save()` at
 * the moments that matter (after each turn, before exiting).
 */
export function createSessionRecorder({
  dir = SESSION_DIR,
  model = null,
  cwd = process.cwd(),
  now = () => new Date(),
  id = null,
  createdAt = null,
} = {}) {
  const startedAt = now();
  let sessionId_ = id || sessionId(startedAt);
  // The session's original creation date: a resumed conversation keeps it, so the
  // file keeps saying when the conversation started (not when it was reopened).
  let created = createdAt ? new Date(createdAt) : startedAt;
  if (Number.isNaN(created.getTime())) created = startedAt;
  let savedAt = null;
  let saves = 0;

  return {
    get id() {
      return sessionId_;
    },
    dir,
    model,
    get startedAt() {
      return created.toISOString();
    },
    get path() {
      return sessionPath(sessionId_, { dir });
    },
    get saves() {
      return saves;
    },
    get savedAt() {
      return savedAt;
    },
    /**
     * Continue an existing session instead of starting a new one.
     *
     * Resuming a conversation must keep saving into the file it came from —
     * otherwise every `/sessions` fork leaves a stray file behind and the one the
     * user picked stops being updated.
     *
     * @param {string} nextId the resumed session id
     * @param {object} [extra] `{ createdAt, model }` taken from the session file
     */
    adopt(nextId, { createdAt: created_ = null, model: adoptedModel = undefined } = {}) {
      if (nextId == null || String(nextId).trim() === '') {
        throw new Error('adopt() requires a session id.');
      }
      sessionId_ = String(nextId).trim();
      if (created_) {
        const at = new Date(created_);
        if (!Number.isNaN(at.getTime())) created = at;
      }
      if (adoptedModel !== undefined && adoptedModel !== null) model = adoptedModel;
      savedAt = null;
      return sessionId_;
    },
    /**
     * Snapshot `chunks` into the session file.
     *
     * @param {any[]} chunks the live context window contents
     * @param {object} [extra] extra metadata (`stats`, `reason`, …)
     * @returns {object} the written record (see utils/session-store.js#writeSession)
     */
    save(chunks = [], extra = {}) {
      const at = now();
      const record = writeSession(
        serializeSession({
          id: sessionId_,
          createdAt: created,
          updatedAt: at,
          model,
          cwd,
          chunks,
          stats: extra.stats || {},
          usage: extra.usage || {},
        }),
        { dir },
      );
      savedAt = at.toISOString();
      saves += 1;
      return record;
    },
    /** Save only when the window holds something worth keeping. */
    saveIfUsed(chunks = [], extra = {}) {
      if (!Array.isArray(chunks) || chunks.length === 0) return null;
      return this.save(chunks, extra);
    },
  };
}

/** Every stored session, newest first (see utils/session-store.js#listSessions). */
export function listStoredSessions({ dir = SESSION_DIR } = {}) {
  return listSessions({ dir });
}

/** Load a stored session by id, ready to be replayed into a ContextWindow. */
export function loadStoredSession(id, { dir = SESSION_DIR } = {}) {
  return loadSession(id, { dir });
}

/** The most recent stored session, or null. */
export function loadLatestSession({ dir = SESSION_DIR } = {}) {
  return latestSession({ dir });
}

export { describeSession, sessionPath, sessionId };
