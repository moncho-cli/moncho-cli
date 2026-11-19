import fs from 'fs';
import path from 'path';
import { normalizeModelUsage } from './usage-stats.js';
import { writeFileVerified } from './file-io.js';
import { resolveProjectPath } from './path-safety.js';

/**
 * Conversation sessions on disk (task.md item 3).
 *
 * A session is one dated file under `agent/sessions/` holding the **full context**
 * of a conversation — every chunk the ContextWindow holds, verbatim — plus enough
 * metadata to list and resume it. The directory is inside the gitignored `agent/`
 * tree, so sessions never leak into a commit.
 *
 * The format is versioned JSON, pretty printed: the file is meant to be read by a
 * human *and* picked up by the `/sessions` command, so `parseSession()` validates
 * what `serializeSession()` writes and refuses anything else.
 */

/** Directory holding the session files (overridable for tests). */
export const SESSION_DIR = process.env.SESSION_DIR || 'agent/sessions';

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

/** Project-relative path of a session file. */
export function sessionPath(id, { dir = SESSION_DIR } = {}) {
  const name = String(id ?? '').trim();
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new SessionStoreError('INVALID_ID', `Unsafe session id: ${id}`);
  }
  return `${dir.replace(/\/+$/, '')}/${name}.json`;
}

/** Normalise the caller's data into the on-disk shape. */
export function serializeSession({
  id,
  createdAt = new Date(),
  updatedAt = null,
  model = null,
  mode = null,
  work = false,
  cwd = null,
  chunks = [],
  stats = {},
  usage = {},
} = {}) {
  const created = createdAt instanceof Date ? createdAt.toISOString() : String(createdAt);
  const updated = updatedAt instanceof Date
    ? updatedAt.toISOString()
    : (updatedAt == null ? created : String(updatedAt));

  if (!Array.isArray(chunks)) {
    throw new SessionStoreError('INVALID_CHUNKS', 'chunks must be an array.');
  }

  return {
    version: SESSION_FORMAT_VERSION,
    id: id ?? sessionId(new Date(created)),
    createdAt: created,
    updatedAt: updated,
    model,
    // The mode and the `work:on` lock sail with the conversation, so a resumed session
    // opens in the state it was left in (docs/interface/modes).
    mode: mode == null ? null : String(mode),
    work: Boolean(work),
    cwd,
    counts: {
      chunks: chunks.length,
      roles: countRoles(chunks),
    },
    stats: { ...stats },
    usage: normalizeModelUsage(usage),
    chunks: chunks.map((chunk) => ({ ...chunk })),
  };
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

/** The chunks to restore into a ContextWindow, validated. */
export function sessionChunks(session) {
  const parsed = parseSession(formatSession(session));
  return parsed.chunks.map((chunk) => ({ ...chunk }));
}

/** The per-model token table of a session, ready to seed a usage meter. */
export function sessionUsage(session) {
  return normalizeModelUsage(parseSession(formatSession(session)).usage);
}

/**
 * The stored intent mode of a session, or `null` when the file carries none.
 *
 * `null` and a junk mode are deliberately different answers: an old file written before
 * the mode existed restores **nothing** (the session keeps the state it opened with),
 * while a file that *does* carry a mode hands it back verbatim for
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

/** Write (or overwrite) a session file, verified byte-for-byte. */
export function writeSession(session, { dir = SESSION_DIR } = {}) {
  const record = serializeSession({ ...session, updatedAt: new Date() });
  const relative = sessionPath(record.id, { dir });
  const written = writeFileVerified(relative, formatSession(record));
  return { ...written, session: record, id: record.id };
}

/** True when the session directory exists. */
export function sessionsDirExists({ dir = SESSION_DIR } = {}) {
  try {
    return fs.existsSync(resolveProjectPath(dir));
  } catch {
    return false;
  }
}

/**
 * Every stored session, newest first, as light summaries (metadata only: the
 * chunks are not parsed, so a big directory still lists instantly).
 */
export function listSessions({ dir = SESSION_DIR } = {}) {
  let absolute;
  try {
    absolute = resolveProjectPath(dir);
  } catch {
    return [];
  }
  if (!fs.existsSync(absolute)) return [];

  const out = [];
  for (const name of fs.readdirSync(absolute)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(absolute, name);
    const id = name.slice(0, -'.json'.length);
    let summary = { id, path: `${dir.replace(/\/+$/, '')}/${name}` };
    try {
      const parsed = parseSession(fs.readFileSync(file, 'utf-8'));
      summary = {
        ...summary,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        model: parsed.model,
        counts: parsed.counts || { chunks: parsed.chunks.length, roles: countRoles(parsed.chunks) },
        stats: parsed.stats || {},
        bytes: fs.statSync(file).size,
      };
    } catch (error) {
      summary = { ...summary, error: error.code || 'INVALID_SESSION', message: error.message };
    }
    out.push(summary);
  }

  // Date-named ids sort lexicographically, newest first. A file that cannot be
  // read never tops the picker: it is listed last instead.
  return out.sort((a, b) => {
    if (Boolean(a.error) !== Boolean(b.error)) return a.error ? 1 : -1;
    return String(b.id).localeCompare(String(a.id));
  });
}

/** Load one session by id. Throws when it is missing or malformed. */
export function loadSession(id, { dir = SESSION_DIR } = {}) {
  const relative = sessionPath(id, { dir });
  const absolute = resolveProjectPath(relative);
  if (!fs.existsSync(absolute)) {
    throw new SessionStoreError('NOT_FOUND', `No session stored at ${relative}.`, { id });
  }
  return parseSession(fs.readFileSync(absolute, 'utf-8'));
}

/** The most recent session, or null when none is stored. */
export function latestSession({ dir = SESSION_DIR } = {}) {
  const [first] = listSessions({ dir });
  if (!first) return null;
  try {
    return loadSession(first.id, { dir });
  } catch {
    return null;
  }
}

/** One line describing a summary, for the session picker. */
export function describeSession(summary) {
  if (!summary) return '';
  if (summary.error) return `${summary.id} — unreadable (${summary.error})`;
  const when = summary.updatedAt || summary.createdAt || '';
  const turns = summary.counts?.roles?.user ?? 0;
  const chunks = summary.counts?.chunks ?? 0;
  const model = summary.model ? ` · ${summary.model}` : '';
  return `${summary.id} — ${turns} turn(s), ${chunks} chunk(s)${model} · ${when}`;
}
