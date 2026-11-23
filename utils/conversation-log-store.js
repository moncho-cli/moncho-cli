import { readFileIfExists, writeFileVerified } from './file-io.js';
import { SESSION_DIR, conversationPath } from './session-store.js';
import {
  conversationLogChunks,
  conversationLogMeta,
  formatConversationLog,
  serializeConversationLog,
} from './conversation-log.js';

/**
 * The **filesystem** half of the uncompacted history (`docs/runtime/conversation-log`).
 *
 * `utils/conversation-log.js` owns the shape of `conversation.json`; this module owns
 * *where* it is and how it is read and written, exactly the split `utils/session-format.js`
 * and `utils/session-store.js` already keep for `context.json`. The two files sit side by
 * side in the same session folder:
 *
 *     agent/sessions/<id>/context.json       the window that is sent (compactable)
 *     agent/sessions/<id>/conversation.json  every chunk, all the way back (append-only)
 *
 * Two rules carry the value:
 *
 *  - **the write is ordered.** The history is written *after* the live record, so a save
 *    that fails halfway leaves the window on disk and only the history one save behind.
 *    Never the reverse: a conversation that cannot be resumed is worse than a history
 *    that is a moment stale.
 *  - **reading is forgiving.** A missing file (a session written before the log existed)
 *    and an unreadable one (a half-written file, an unknown version) both answer `null`,
 *    never a throw. The caller is resuming a conversation it can still read from
 *    `context.json`, so a broken history must not be able to block the resume — the same
 *    reason `listSessions()` reports a broken record instead of dropping it.
 */

/**
 * Write the uncompacted history for one session, verified byte-for-byte.
 *
 * @param {object} parts `{ id, createdAt, updatedAt, model, cwd, chunks }`
 * @param {{dir?: string}} [options] the sessions directory (injectable for tests)
 * @returns {{path: string, bytes: number, verified: true, log: object}}
 */
export function writeConversationLog(parts = {}, { dir = SESSION_DIR } = {}) {
  const record = serializeConversationLog({ ...parts, updatedAt: parts.updatedAt || new Date() });  const relative = conversationPath(record.id, { dir });
  const written = writeFileVerified(relative, formatConversationLog(record));
  return { ...written, log: record };
}

/**
 * The uncompacted chunks of one session, or `null` when there is nothing readable.
 *
 * `null` is a real answer, not a failure: it means "this session has no separate
 * history", which is exactly how a session written before the file existed looks.
 */
export function readConversationLog(id, { dir = SESSION_DIR } = {}) {
  let text = null;
  try {
    text = readFileIfExists(conversationPath(id, { dir }));
  } catch {
    return null;
  }
  return conversationLogChunks(text);
}

/**
 * The per-chunk provenance a stored history kept, or `null` when there is none
 * (`docs/runtime/chunk-provenance`).
 *
 * Separate from `readConversationLog()` because the two are wanted at different moments:
 * replaying a conversation wants the chunks, while an investigation into how a build
 * behaved wants the provenance and does not need the chunks at all.
 */
export function readConversationLogMeta(id, { dir = SESSION_DIR } = {}) {
  let text = null;
  try {
    text = readFileIfExists(conversationPath(id, { dir }));
  } catch {
    return null;
  }
  return conversationLogMeta(text);
}

/** True when a session folder owns an uncompacted history file. */
export function hasConversationLog(id, { dir = SESSION_DIR } = {}) {
  try {
    return readFileIfExists(conversationPath(id, { dir })) !== null;
  } catch {
    return false;
  }
}
