import { countRoles } from './session-format.js';
import { chunkToText } from './compaction-render.js';

/**
 * The **chunkpaction capture**: the raw chunks a collapsed section replaced
 * (`docs/context/chunkpaction`).
 *
 * A collapse (`utils/item-collapse.js`) replaces a solved item's whole section with one
 * deterministic summary, and the summary says the detail is still available. That claim
 * has to be *followable*: the journal keeps every chunk, but it is a file on disk and no
 * tool reads it, so a pointer to it is a promise the model cannot cash. This module owns
 * the second file, `chunkpaction.json`, which keeps the raw chunks of each collapsed
 * section under an id the summary names:
 *
 *     agent/sessions/<id>/context.json        the window that is sent (compactable)
 *     agent/sessions/<id>/conversation.json   every chunk, all the way back (append-only)
 *     agent/sessions/<id>/chunkpaction.json   the raw chunks of each collapsed section
 *
 * The shape is the same *kind* of document as the conversation log — dated, versioned,
 * with counts so a listing can describe an entry without loading its chunks — and it is
 * deliberately a smaller one: a capture is not a conversation, it is one section of one.
 *
 * Two rules carry the value, and both are the capture store's rules applied to a file:
 *
 *  - **ids are monotonic and never reused.** A summary in an old transcript names
 *    `capture: 2`; that id must keep meaning the section it meant, or a stale pointer
 *    would silently address a newer one. The record therefore carries its own counter
 *    (`nextCapture`) rather than deriving the next id from the entries it happens to
 *    hold.
 *  - **the chunks are copied, never referenced.** A later mutation of the live window
 *    must not be able to rewrite what a capture already holds, exactly as
 *    `serializeConversationLog()` copies its chunks.
 *
 * Pure: `serializeChunkpaction()` builds the record, `appendCapture()` adds one entry,
 * `captureText()` renders one for a reader, and nothing here touches a filesystem, so
 * every rule is provable on a string.
 */

/** Bumped when the on-disk shape changes; older files are refused, not guessed. */
export const CHUNKPACTION_VERSION = 1;

/** The file's own name inside a session folder. */
export const CHUNKPACTION_FILE = 'chunkpaction.json';

/** A coded refusal, so a caller can react instead of crashing on a bad file. */
export class ChunkpactionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ChunkpactionError';
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

/** A capture id: a positive whole number, or `null` when the value is not one. */
export function normalizeCaptureId(value) {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * An empty record for one session, ready to take its first capture.
 *
 * `nextCapture` starts at 1 and is the record's own counter: the next id is read from
 * here and never derived from the entries, so dropping an entry could not hand its id to
 * a later one.
 */
export function emptyChunkpaction(id, { createdAt = new Date() } = {}) {
  if (typeof id !== 'string' || id === '') {
    throw new ChunkpactionError('INVALID_ID', 'A chunkpaction capture needs the session id it belongs to.');
  }
  const created = isoString(createdAt, new Date().toISOString());
  return {
    version: CHUNKPACTION_VERSION,
    kind: 'chunkpaction',
    id,
    createdAt: created,
    updatedAt: created,
    nextCapture: 1,
    captures: [],
  };
}

/** Normalise the caller's data into the on-disk shape. */
export function serializeChunkpaction({
  id,
  createdAt = new Date(),
  updatedAt = null,
  nextCapture = 1,
  captures = [],
} = {}) {
  if (typeof id !== 'string' || id === '') {
    throw new ChunkpactionError('INVALID_ID', 'A chunkpaction capture needs the session id it belongs to.');
  }
  if (!Array.isArray(captures)) {
    throw new ChunkpactionError('INVALID_CAPTURES', 'captures must be an array.');
  }

  const created = isoString(createdAt, new Date().toISOString());
  const entries = captures.map((entry) => ({
    capture: normalizeCaptureId(entry?.capture),
    item: typeof entry?.item === 'string' ? entry.item : null,
    at: isoString(entry?.at, created),
    counts: { chunks: Array.isArray(entry?.chunks) ? entry.chunks.length : 0, roles: countRoles(entry?.chunks || []) },
    // Copied, so a later mutation of the live window cannot rewrite what is on disk.
    chunks: (Array.isArray(entry?.chunks) ? entry.chunks : []).map((chunk) => ({ ...chunk })),
  }));

  const highest = entries.reduce((max, entry) => Math.max(max, entry.capture || 0), 0);
  return {
    version: CHUNKPACTION_VERSION,
    kind: 'chunkpaction',
    id,
    createdAt: created,
    updatedAt: isoString(updatedAt, created),
    // The counter never goes backwards, even against a hand-edited file.
    nextCapture: Math.max(normalizeCaptureId(nextCapture) || 1, highest + 1),
    captures: entries,
  };
}

/** The pretty-printed JSON actually written to disk (trailing newline included). */
export function formatChunkpaction(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Parse and validate chunkpaction contents. Throws ChunkpactionError on junk. */
export function parseChunkpaction(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ChunkpactionError('INVALID_JSON', `Chunkpaction capture is not valid JSON: ${error.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ChunkpactionError('INVALID_RECORD', 'Chunkpaction capture must hold a JSON object.');
  }
  if (parsed.version !== CHUNKPACTION_VERSION) {
    throw new ChunkpactionError(
      'UNSUPPORTED_VERSION',
      `Chunkpaction version ${parsed.version} is not supported (expected ${CHUNKPACTION_VERSION}).`,
      { version: parsed.version },
    );
  }
  if (typeof parsed.id !== 'string' || !parsed.id) {
    throw new ChunkpactionError('INVALID_RECORD', 'Chunkpaction capture is missing the session id it belongs to.');
  }
  if (!Array.isArray(parsed.captures)) {
    throw new ChunkpactionError('INVALID_RECORD', 'Chunkpaction capture is missing its captures array.');
  }
  return parsed;
}

/**
 * Add one capture to a record, returning the new record and the entry that was added.
 *
 * The id comes from the record's own counter, so it is monotonic across writes and never
 * reused. Pure: the caller's record is not modified.
 *
 * @param {object} record a serialized chunkpaction record
 * @param {{item?: string|null, chunks?: any[], at?: Date|string}} capture the section
 * @returns {{record: object, entry: object}}
 */
export function appendCapture(record, { item = null, chunks = [], at = new Date() } = {}) {
  const current = parseChunkpaction(formatChunkpaction(record));
  const id = normalizeCaptureId(current.nextCapture) || 1;
  const entry = {
    capture: id,
    item: typeof item === 'string' ? item : null,
    at: isoString(at, new Date().toISOString()),
    chunks: (Array.isArray(chunks) ? chunks : []).map((chunk) => ({ ...chunk })),
  };

  const next = serializeChunkpaction({
    ...current,
    updatedAt: at,
    nextCapture: id + 1,
    captures: [...current.captures, entry],
  });

  return { record: next, entry: next.captures[next.captures.length - 1] };
}

/** One capture entry by id, or `null` when this record does not hold it. */
export function findCapture(record, capture) {
  const id = normalizeCaptureId(capture);
  if (id === null || !record || !Array.isArray(record.captures)) return null;
  return record.captures.find((entry) => normalizeCaptureId(entry?.capture) === id) || null;
}

/**
 * The captures a record holds, described without their chunks.
 *
 * This is what a summary lists and what a reader is offered first: an id, the item it
 * belongs to, when it was taken and how big it is — everything needed to decide whether
 * to read it, and nothing that would cost the window.
 */
export function captureIndex(record) {
  if (!record || !Array.isArray(record.captures)) return [];
  return record.captures.map((entry) => ({
    capture: normalizeCaptureId(entry?.capture),
    item: typeof entry?.item === 'string' ? entry.item : null,
    at: entry?.at ?? null,
    chunks: Array.isArray(entry?.chunks) ? entry.chunks.length : 0,
  }));
}

/**
 * Render one capture's chunks as the text a reader pages over.
 *
 * The rendering is `utils/compaction-render.js#chunkToText` — the same words the
 * summariser was given — so what the model reads back is the record it lost, not a
 * second interpretation of it. The result is a plain string, which is what lets the
 * reader reuse the pure paging in `utils/capture-window.js`.
 */
export function captureText(entry) {
  const chunks = Array.isArray(entry?.chunks) ? entry.chunks : [];
  const header = [
    `[chunkpaction capture ${normalizeCaptureId(entry?.capture) ?? '?'}]`,
    entry?.item ? `item: ${entry.item}` : null,
    entry?.at ? `taken: ${entry.at}` : null,
    `${chunks.length} chunk(s), as they were when the section was collapsed`,
  ].filter(Boolean).join('\n');
  return [header, ...chunks.map(chunkToText).filter(Boolean)].join('\n\n---\n\n');
}

/** The chunks to restore from a capture: copies, so a caller cannot mutate the record. */
export function captureChunks(entry) {
  const chunks = Array.isArray(entry?.chunks) ? entry.chunks : [];
  return chunks.map((chunk) => ({ ...chunk }));
}
