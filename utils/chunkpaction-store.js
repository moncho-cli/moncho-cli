import { readFileIfExists, writeFileVerified } from './file-io.js';
import { SESSION_DIR, chunkpactionPath } from './session-store.js';
import {
  appendCapture,
  emptyChunkpaction,
  formatChunkpaction,
  parseChunkpaction,
  serializeChunkpaction,
} from './chunkpaction.js';

/**
 * The **filesystem** half of the chunkpaction captures (`docs/context/chunkpaction`).
 *
 * `utils/chunkpaction.js` owns the shape of `chunkpaction.json`; this module owns *where*
 * it is and how it is read and written, exactly the split `utils/conversation-log.js` and
 * `utils/conversation-log-store.js` already keep for `conversation.json`. The three files
 * sit side by side in the same session folder:
 *
 *     agent/sessions/<id>/context.json        the window that is sent (compactable)
 *     agent/sessions/<id>/conversation.json   every chunk, all the way back (append-only)
 *     agent/sessions/<id>/chunkpaction.json   the raw chunks of each collapsed section
 *
 * Two rules carry the value, and they are the conversation log's rules:
 *
 *  - **a capture is appended, never rewritten.** The record is read, one entry is added
 *    and the whole file is written back verified. Nothing here trims, reorders or
 *    renumbers: an id a summary already names must keep meaning what it meant.
 *  - **reading is forgiving.** A missing file (a session that never collapsed anything)
 *    and an unreadable one (a half-written file, an unknown version) both answer `null`,
 *    never a throw. A broken capture file must not be able to block a resume, and the
 *    caller that is collapsing a section can simply start a fresh record.
 */

/** The record of one session, or `null` when there is nothing readable. */
export function readChunkpaction(id, { dir = SESSION_DIR } = {}) {
  let text = null;
  try {
    text = readFileIfExists(chunkpactionPath(id, { dir }));
  } catch {
    return null;
  }
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    return parseChunkpaction(text);
  } catch {
    return null;
  }
}

/** True when a session folder owns a chunkpaction file. */
export function hasChunkpaction(id, { dir = SESSION_DIR } = {}) {
  try {
    return readFileIfExists(chunkpactionPath(id, { dir })) !== null;
  } catch {
    return false;
  }
}

/**
 * Append one collapsed section and write the file back, verified byte-for-byte.
 *
 * The record is read first so the new id continues the file's own counter: an id is
 * monotonic across writes and never reused, which is what lets a summary name one and
 * still be right later.
 *
 * @param {string} id the session id
 * @param {{item?: string|null, chunks?: any[], at?: Date|string}} capture the section
 * @param {{dir?: string}} [options] the sessions directory (injectable for tests)
 * @returns {{path: string, bytes: number, verified: true, entry: object, record: object}}
 */
export function writeChunkpactionCapture(id, capture = {}, { dir = SESSION_DIR } = {}) {
  const existing = readChunkpaction(id, { dir }) || emptyChunkpaction(id);
  const { record, entry } = appendCapture(existing, capture);
  const written = writeFileVerified(chunkpactionPath(id, { dir }), formatChunkpaction(record));
  return { ...written, entry, record };
}

/**
 * Replace a session's captures wholesale (tests and a deliberate reset).
 *
 * Kept separate from the append path on purpose: the append is the operation the
 * collapse performs, and a full write is the one that could renumber a file.
 */
export function writeChunkpaction(id, { captures = [], nextCapture = 1, createdAt = new Date() } = {}, { dir = SESSION_DIR } = {}) {
  const record = serializeChunkpaction({ id, createdAt, captures, nextCapture });
  const written = writeFileVerified(chunkpactionPath(id, { dir }), formatChunkpaction(record));
  return { ...written, record };
}
