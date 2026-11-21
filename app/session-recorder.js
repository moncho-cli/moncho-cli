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
import { writeConversationLog } from '../utils/conversation-log-store.js';
import { getSessionTaskContent, getSessionPlanContent } from '../utils/host.js';

/**
 * Keeps the conversation being had on disk (task.md item 3).
 *
 * The recorder owns the *current* session: its id, when it started and the
 * model it is talking to. `save(chunks)` snapshots the live context window —
 * every chunk, verbatim — into `agent/sessions/<id>/context.json`, the record
 * inside the conversation's own folder, so a conversation can be listed,
 * inspected and picked up again later (`/sessions`).
 *
 * It is deliberately dumb about *when* to save: the host loop calls `save()` at
 * the moments that matter (after each turn, before exiting).
 */

/** The state a fresh conversation opens with: no stored mode, no lock. */
const NO_STATE = Object.freeze({ mode: null, work: false });

export function createSessionRecorder({
  dir = SESSION_DIR,
  model = null,
  stateOf = null,
  // The look in force, read live on every save like `stateOf`: a skin applied halfway
  // through a conversation is the one the record carries (`docs/interface/skins`).
  skinOf = null,
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
     * Start a fresh conversation: a new id, a new start date, no saved state.
     *
     * This is the counterpart of `adopt()` and it is deliberately the *identity* half
     * alone — it does not touch the context window, the usage table or the view, because
     * those belong to the host that drives them (`/new` clears the window and the
     * accounting table itself, then rotates the recorder through here).
     *
     * The session already on disk is left exactly where it is: `/new` opens a *second*
     * conversation beside the first, and `/sessions` still lists the first.
     *
     * @returns {string} the new session id
     */
    rotate() {
      const at = now();
      created = at;
      savedAt = null;
      sessionId_ = sessionId(at);
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
      const state = typeof stateOf === 'function' ? (stateOf() || NO_STATE) : NO_STATE;
      // The look is read *live*, exactly like the mode: the user may apply a skin halfway
      // through a conversation, and the file must record the one that was on when it was
      // last saved (`docs/interface/skins`). Presentation only — it never reaches a chunk.
      const skin = typeof skinOf === 'function' ? (skinOf() || null) : null;

      // The tracking files the session owns, read through the host registry.
      const taskContent = getSessionTaskContent();
      const planContent = getSessionPlanContent();

      const record = writeSession(
        serializeSession({
          id: sessionId_,
          createdAt: created,
          updatedAt: at,
          model,
          mode: state.mode ?? null,
          work: Boolean(state.work),
          skin,
          cwd,
          chunks,
          // The append time of each chunk, index-aligned with them and never on a
          // chunk: the chunks are sent to the provider verbatim (utils/chunk-stamps.js,
          // docs/interface/session-stamps). Absent for a caller that only knows the window.
          stamps: Array.isArray(extra.stamps) ? extra.stamps : null,
          stats: extra.stats || {},
          usage: extra.usage || {},
          taskContent,
          planContent,
        }),
        { dir },
      );
      savedAt = at.toISOString();
      saves += 1;
      // The uncompacted history, written *after* the record and never trimmed by a
      // compaction (utils/conversation-log-store.js, docs/runtime/conversation-log).
      // With no journal handed over (a caller that only knows the window) the window
      // itself is the best record available.
      const conversationLog = writeConversationLog({
        id: sessionId_,
        createdAt: created,
        updatedAt: at,
        model,
        cwd,
        chunks: Array.isArray(extra.journal) ? extra.journal : chunks,
      }, { dir });
      return { ...record, conversationLog };
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