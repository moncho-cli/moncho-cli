import { countRoles } from './session-format.js';
import { isChunkMeta, normalizeMeta, summarizeMeta } from './chunk-meta.js';

/**
 * The **uncompacted** history of a conversation, kept beside the record
 * (`docs/runtime/conversation-log`).
 *
 * `context.json` holds the window that is *sent* to the model, so a compaction rewrites
 * it: the older share becomes one summary chunk and the original messages are gone from
 * that file. That is the right shape for a request and the wrong shape for a record —
 * the verbatim stretch of work the summary paraphrases is exactly what a reader wants
 * back later. This module owns the shape of the second file, `conversation.json`:
 *
 *     agent/sessions/<id>/context.json       the window that is sent (compactable)
 *     agent/sessions/<id>/conversation.json  every chunk, all the way back (append-only)
 *
 * It is the same *kind* of document as a session record — dated, versioned, with counts
 * so a listing can describe it without loading the chunks — so it reuses
 * `countRoles()` and the same pretty-printed JSON on disk. It is deliberately a smaller
 * shape: a log of the conversation has no mode, no lock, no usage table and no tracking
 * content, because all of those are the live session's business and are already stored
 * in `context.json`.
 *
 * Pure: `serializeConversationLog()` builds the record, `parseConversationLog()`
 * validates it, and nothing here touches a filesystem, so every rule is provable on a
 * string.
 */

/** Bumped when the on-disk shape changes; older files are refused, not guessed. */
export const CONVERSATION_LOG_VERSION = 1;

/** A coded refusal, so a caller can react instead of crashing on a bad file. */
export class ConversationLogError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ConversationLogError';
    this.code = code;
    this.details = details;
  }
}

/** The ISO string of a Date, or of a value that is already one. */
function isoString(value, fallback = null) {
  const at = value instanceof Date ? value : (value == null ? null : new Date(value));
  if (!at || Number.isNaN(at.getTime())) return fallback;
  return at.toISOString();
}

/**
 * Normalise the caller's data into the on-disk shape.
 *
 * The chunks are copied (`{ ...chunk }`) exactly as `serializeSession()` does it, so a
 * later mutation of the live window can never rewrite what is already on disk.
 *
 * @param {object} parts
 * @param {string} parts.id the session id (required)
 * @param {any[]} [parts.chunks] every chunk of the conversation, oldest first
 * @returns {object} the record to write
 */
export function serializeConversationLog({
  id,
  createdAt = new Date(),
  updatedAt = null,
  model = null,
  cwd = null,
  chunks = [],
  meta = null,
} = {}) {
  if (typeof id !== 'string' || id === '') {
    throw new ConversationLogError('INVALID_ID', 'A conversation log needs the session id it belongs to.');
  }
  if (!Array.isArray(chunks)) {
    throw new ConversationLogError('INVALID_CHUNKS', 'chunks must be an array.');
  }

  const created = isoString(createdAt, new Date().toISOString());
  const record = {
    version: CONVERSATION_LOG_VERSION,
    kind: 'conversation-log',
    id,
    createdAt: created,
    updatedAt: isoString(updatedAt, created),
    model,
    cwd,
    counts: { chunks: chunks.length, roles: countRoles(chunks) },
    chunks: chunks.map((chunk) => ({ ...chunk })),
  };

  // The provenance of each chunk — the build that wrote it and what it weighed
  // (utils/chunk-meta.js, docs/runtime/chunk-provenance). Written only when a caller
  // supplies it, so a log without it is byte-for-byte what it always was, and a file
  // written before the field existed still parses.
  if (Array.isArray(meta) && meta.some(isChunkMeta)) {
    record.meta = normalizeMeta(meta, record.chunks.length);
    record.metaSummary = summarizeMeta(record.meta);
  }

  return record;
}

/** The pretty-printed JSON actually written to disk (trailing newline included). */
export function formatConversationLog(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Parse and validate conversation-log contents. Throws ConversationLogError on junk. */
export function parseConversationLog(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConversationLogError('INVALID_JSON', `Conversation log is not valid JSON: ${error.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConversationLogError('INVALID_LOG', 'Conversation log must hold a JSON object.');
  }
  if (parsed.version !== CONVERSATION_LOG_VERSION) {
    throw new ConversationLogError(
      'UNSUPPORTED_VERSION',
      `Conversation log version ${parsed.version} is not supported (expected ${CONVERSATION_LOG_VERSION}).`,
      { version: parsed.version },
    );
  }
  if (typeof parsed.id !== 'string' || !parsed.id) {
    throw new ConversationLogError('INVALID_LOG', 'Conversation log is missing the session id it belongs to.');
  }
  if (!Array.isArray(parsed.chunks)) {
    throw new ConversationLogError('INVALID_LOG', 'Conversation log is missing its chunks array.');
  }
  return parsed;
}

/**
 * The chunks to restore as the uncompacted history.
 *
 * A truncated or unreadable log is not an error for the *caller* that is resuming a
 * conversation: the live window is still there, so the honest fallback is `null` —
 * "there is no separate history", which is exactly what a session written before this
 * file existed looks like.
 */
export function conversationLogChunks(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    return parseConversationLog(text).chunks.map((chunk) => ({ ...chunk }));
  } catch {
    return null;
  }
}

/**
 * The provenance a stored log kept, or `null` when it kept none.
 *
 * `null` is the honest answer for a log written before the field existed, and it is the
 * same shape `conversationLogChunks()` answers: a reader that wants the chunks is not
 * forced to care about the provenance, and vice versa.
 */
export function conversationLogMeta(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    const parsed = parseConversationLog(text);
    if (!Array.isArray(parsed.meta)) return null;
    return normalizeMeta(parsed.meta, parsed.chunks.length);
  } catch {
    return null;
  }
}
