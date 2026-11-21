import { normalizeModelUsage } from './usage-stats.js';
import { isStamp, normalizeStamps } from './chunk-stamps.js';

/**
 * The **shape** of a stored conversation.
 *
 * A session record is a dated, versioned JSON document holding the full context of a
 * conversation plus the metadata needed to list and resume it. This module owns that
 * shape and nothing else: `serializeSession()` builds it, `parseSession()` validates
 * it, and the small accessors read one field back. It touches no filesystem, so every
 * rule here is provable on a string.
 *
 * *Where* a record lives — the session folder, the migration from the older flat
 * layout, the directory scan — belongs to `utils/session-store.js`. The split keeps
 * both halves small enough to read at once.
 */

/** Bumped when the on-disk shape changes; older files are refused, not guessed. */
export const SESSION_FORMAT_VERSION = 1;

export class SessionStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SessionStoreError';
    this.code = code;
    this.details = details;
  }
}

/** A filesystem-safe, lexicographically sortable session id: `2026-02-14T10-30-00-000Z`. */
export function sessionId(date = new Date()) {
  const at = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(at.getTime())) {
    throw new SessionStoreError('INVALID_DATE', 'A valid Date is required to name a session.');
  }
  return at.toISOString().replace(/[:.]/g, '-');
}

/** Normalise the caller's data into the on-disk shape. */
export function serializeSession({
  id,
  createdAt = new Date(),
  updatedAt = null,
  model = null,
  mode = null,
  work = false,
  skin = null,
  cwd = null,
  chunks = [],
  stamps = null,
  stats = {},
  usage = {},
  taskContent = null,
  planContent = null,
} = {}) {
  const created = createdAt instanceof Date ? createdAt.toISOString() : String(createdAt);
  const updated = updatedAt instanceof Date
    ? updatedAt.toISOString()
    : (updatedAt == null ? created : String(updatedAt));

  if (!Array.isArray(chunks)) {
    throw new SessionStoreError('INVALID_CHUNKS', 'chunks must be an array.');
  }

  const record = {
    version: SESSION_FORMAT_VERSION,
    id: id ?? sessionId(new Date(created)),
    createdAt: created,
    updatedAt: updated,
    model,
    // The mode and the `work:on` lock sail with the conversation, so a resumed session
    // opens in the state it was left in (docs/interface/modes).
    mode: mode == null ? null : String(mode),
    work: Boolean(work),
    // The look the conversation was held in (`docs/interface/skins`). Presentation only:
    // it never reaches the model, but it does belong to the record — reopening a session
    // should reopen it in the colours it was written in. `null` means "not recorded",
    // which a resume leaves alone, while a name asks for that skin.
    skin: typeof skin === 'string' && skin.trim() ? skin.trim() : null,
    cwd,
    counts: {
      chunks: chunks.length,
      roles: countRoles(chunks),
    },
    stats: { ...stats },
    usage: normalizeModelUsage(usage),
    chunks: chunks.map((chunk) => ({ ...chunk })),
  };

  // The append time of each chunk, beside the chunks and never on them
  // (utils/chunk-stamps.js, docs/interface/session-stamps). Written only when a caller
  // supplies them, so a record without them is byte-for-byte what it always was — and a
  // file written before the field existed still parses, because the marks are optional.
  if (Array.isArray(stamps) && stamps.some(isStamp)) {
    record.stamps = normalizeStamps(stamps, record.chunks.length);
  }

  if (taskContent !== null) record.taskContent = taskContent;
  if (planContent !== null) record.planContent = planContent;

  return record;
}

/** Chunk count per role, so a listing can describe a session without loading it. */
export function countRoles(chunks = []) {
  const roles = {};
  for (const chunk of chunks) {
    const role = chunk?.role || 'unknown';
    roles[role] = (roles[role] || 0) + 1;
  }
  return roles;
}

/** The pretty-printed JSON actually written to disk (trailing newline included). */
export function formatSession(session) {
  return `${JSON.stringify(session, null, 2)}\n`;
}

/** Parse and validate session file contents. Throws SessionStoreError on junk. */
export function parseSession(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SessionStoreError('INVALID_JSON', `Session file is not valid JSON: ${error.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SessionStoreError('INVALID_SESSION', 'Session file must hold a JSON object.');
  }
  if (parsed.version !== SESSION_FORMAT_VERSION) {
    throw new SessionStoreError(
      'UNSUPPORTED_VERSION',
      `Session format ${parsed.version} is not supported (expected ${SESSION_FORMAT_VERSION}).`,
      { version: parsed.version },
    );
  }
  if (typeof parsed.id !== 'string' || !parsed.id) {
    throw new SessionStoreError('INVALID_SESSION', 'Session file is missing its id.');
  }
  if (!Array.isArray(parsed.chunks)) {
    throw new SessionStoreError('INVALID_SESSION', 'Session file is missing its chunks array.');
  }

  // The per-model usage table is optional: a session written before it existed
  // loads with an empty one instead of being refused, so an old conversation
  // stays resumable.
  parsed.usage = normalizeModelUsage(parsed.usage);
  return parsed;
}

/** The task.md content of a session, or null when not present. */
export function sessionTaskContent(session) {
  const parsed = parseSession(formatSession(session));
  return parsed.taskContent || null;
}

/** The implementation_plan.md content of a session, or null when not present. */
export function sessionPlanContent(session) {
  const parsed = parseSession(formatSession(session));
  return parsed.planContent || null;
}

/** The chunks to restore into a ContextWindow, validated. */
export function sessionChunks(session) {
  const parsed = parseSession(formatSession(session));
  return parsed.chunks.map((chunk) => ({ ...chunk }));
}

/**
 * The append times stored beside the session's chunks, index-aligned with them.
 *
 * A record written before the field existed answers one `null` per chunk, so every
 * later reader can index the list without a length check and the resumed conversation
 * shows no marks rather than a wrong time.
 */
export function sessionStamps(session) {
  const parsed = parseSession(formatSession(session));
  return normalizeStamps(Array.isArray(parsed.stamps) ? parsed.stamps : [], parsed.chunks.length);
}

/** The per-model token table of a session, ready to seed a usage meter. */
export function sessionUsage(session) {
  return normalizeModelUsage(parseSession(formatSession(session)).usage);
}

/**
 * The stored intent mode of a session, or `null` when the record carries none.
 *
 * `null` and a junk mode are deliberately different answers: an old file written before
 * the mode existed restores **nothing** (the session keeps the state it opened with),
 * while a record that *does* carry a mode hands it back verbatim for
 * `createSessionMode()` to normalise — a corrupt value lands in `chat`, the read-only
 * fallback, and never silently in `work` (`docs/interface/modes`).
 *
 * @returns {{mode: string, work: boolean}|null}
 */
export function sessionModeState(session) {
  const parsed = parseSession(formatSession(session));
  if (parsed.mode == null) return null;
  return { mode: String(parsed.mode), work: Boolean(parsed.work) };
}

/**
 * The skin a session was held in, or `null` when the record carries none.
 *
 * `null` and a name are deliberately different: a file written before the field existed
 * restores **nothing**, so a resumed conversation keeps the look the process already has,
 * while a recorded name asks the front end to put that skin back on
 * (`docs/interface/skins`). Colour is presentation only — the value never reaches a chunk.
 */
export function sessionSkin(session) {
  const parsed = parseSession(formatSession(session));
  return typeof parsed.skin === 'string' && parsed.skin.trim() ? parsed.skin.trim() : null;
}