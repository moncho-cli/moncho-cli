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
} = {}) {
  const startedAt = now();
  const sessionId_ = id || sessionId(startedAt);
  let savedAt = null;
  let saves = 0;

  return {
    id: sessionId_,
    dir,
    model,
    startedAt: startedAt.toISOString(),
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
          createdAt: startedAt,
          updatedAt: at,
          model,
          cwd,
          chunks,
          stats: extra.stats || {},
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
