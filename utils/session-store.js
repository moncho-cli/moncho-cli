import fs from 'fs';
import path from 'path';
import { writeFileVerified } from './file-io.js';
import { resolveProjectPath } from './path-safety.js';
import {
  SESSION_FORMAT_VERSION,
  SessionStoreError,
  countRoles,
  parseSession,
  serializeSession,
  sessionId,
  sessionModeState,
  sessionSkin,
  sessionChunks,
  sessionItems,
  sessionPlanContent,
  sessionStamps,
  sessionTaskContent,
  sessionUsage,
  formatSession,
} from './session-format.js';
import { canOpenSession } from './session-version.js';

/**
 * Conversation sessions **on disk** (task.md item 3).
 *
 * A session is one folder under `agent/sessions/`, and the conversation itself is
 * `context.json` inside it — holding the **full context** of the conversation, every
 * chunk the window holds, verbatim, plus the metadata needed to list and resume it:
 *
 *     agent/sessions/<id>/context.json          the conversation (this module)
 *     agent/sessions/<id>/task.md               its checklist   (utils/tracking-store.js)
 *     agent/sessions/<id>/implementation_plan.md its plan       (utils/tracking-store.js)
 *
 * The folder — not a sibling file — is the unit, so everything belonging to one
 * conversation sits together and a resumed session keeps opening the same three files.
 * The directory is inside the gitignored `agent/` tree, so sessions never leak into a
 * commit. The shape of `context.json` lives in `utils/session-format.js`; this module
 * owns *where* it is, the scan of the folder, and the migration of the older layout.
 *
 * Before the folder existed, a session was the flat file `<id>.json` next to it. Those
 * files are still read (the two layouts coexist, and the folder wins when both exist
 * for one id) and are removed as soon as the session is written again, so the tree
 * converges on one layout without a migration script and without losing a conversation.
 */

/** Directory holding the session folders (overridable for tests). */
export const SESSION_DIR = process.env.SESSION_DIR || 'agent/sessions';

/** The conversation record inside a session folder. */
export const SESSION_RECORD_FILE = 'context.json';

/**
 * The **uncompacted** history written beside the record (`docs/runtime/session-store`).
 *
 * `context.json` holds the window that is sent to the model, so a compaction rewrites
 * it; this file holds every chunk the conversation ever had, all the way back, and no
 * compaction ever trims it (task-backlog: "save a conversation.json … the uncompacted
 * version and has all the chunks all the way back").
 */
export const CONVERSATION_LOG_FILE = 'conversation.json';

/**
 * The raw chunks of each collapsed section, kept beside the record
 * (`docs/context/chunkpaction`).
 *
 * A collapse replaces a solved item's section with one summary and the summary names a
 * capture id; this file is what makes that name resolvable. It is written as a section
 * collapses and never trimmed by a compaction, so a pointer in an old summary keeps
 * working for the life of the session.
 */
export const CHUNKPACTION_FILE = 'chunkpaction.json';

export { SESSION_FORMAT_VERSION, SessionStoreError, sessionId, formatSession, parseSession };
export { countRoles, serializeSession, sessionChunks, sessionStamps, sessionModeState, sessionSkin, sessionPlanContent, sessionTaskContent, sessionUsage };
export { sessionItems };

/** A session id, or `INVALID_ID`: the single rule both path helpers below obey. */
function safeSessionName(id) {
  const name = String(id ?? '').trim();
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new SessionStoreError('INVALID_ID', `Unsafe session id: ${id}`);
  }
  return name;
}

/** Project-relative **folder** of one session: `agent/sessions/<id>`. */
export function sessionDir(id, { dir = SESSION_DIR } = {}) {
  return `${String(dir).replace(/\/+$/, '')}/${safeSessionName(id)}`;
}

/** Project-relative path of the conversation record: `agent/sessions/<id>/context.json`. */
export function sessionPath(id, { dir = SESSION_DIR } = {}) {
  return `${sessionDir(id, { dir })}/${SESSION_RECORD_FILE}`;
}

/**
 * Project-relative path of the uncompacted history:
 * `agent/sessions/<id>/conversation.json`.
 */
export function conversationPath(id, { dir = SESSION_DIR } = {}) {
  return `${sessionDir(id, { dir })}/${CONVERSATION_LOG_FILE}`;
}

/**
 * Project-relative path of the chunkpaction captures:
 * `agent/sessions/<id>/chunkpaction.json`.
 */
export function chunkpactionPath(id, { dir = SESSION_DIR } = {}) {
  return `${sessionDir(id, { dir })}/${CHUNKPACTION_FILE}`;
}

/**
 * Where the pre-folder layout kept the conversation: `<dir>/<id>.json`. Kept as a
 * named helper so the migration is one explicit rule instead of a special case
 * spread across `loadSession()` and `listSessions()`.
 */
export function legacySessionPath(id, { dir = SESSION_DIR } = {}) {
  return `${String(dir).replace(/\/+$/, '')}/${safeSessionName(id)}.json`;
}

/** Write (or overwrite) a session record, verified byte-for-byte. */
export function writeSession(session, { dir = SESSION_DIR } = {}) {
  const record = serializeSession({ ...session, updatedAt: new Date() });
  if (session.taskContent !== undefined) record.taskContent = session.taskContent;
  if (session.planContent !== undefined) record.planContent = session.planContent;

  const relative = sessionPath(record.id, { dir });
  const written = writeFileVerified(relative, formatSession(record));

  // The record has landed in its folder, so a flat file left by the older layout is
  // now stale: drop it, and the session has exactly one record again.
  try {
    const legacy = resolveProjectPath(legacySessionPath(record.id, { dir }));
    if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
  } catch {
    // Removing a stale file is housekeeping: it must never fail a good save.
  }

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
 * Every stored session, newest first, as light summaries (the chunks are not kept, so
 * a big directory still lists instantly).
 *
 * Both layouts are scanned. When one id has both a folder record and a flat file, the
 * **folder wins** and the flat file is not listed a second time — the folder is where
 * the next save lands, so it is the live record.
 */
export function listSessions({ dir = SESSION_DIR } = {}) {
  let absolute;
  try {
    absolute = resolveProjectPath(dir);
  } catch {
    return [];
  }
  if (!fs.existsSync(absolute)) return [];

  const base = String(dir).replace(/\/+$/, '');
  const folders = [];
  const legacy = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isDirectory()) folders.push(entry.name);
    else if (entry.name.endsWith('.json')) legacy.push(entry.name);
  }

  const records = new Map();
  for (const id of folders) {
    const file = path.join(absolute, id, SESSION_RECORD_FILE);
    if (fs.existsSync(file)) records.set(id, { id, file, relative: `${base}/${id}/${SESSION_RECORD_FILE}`, layout: 'folder' });
  }
  for (const name of legacy) {
    const id = name.slice(0, -'.json'.length);
    if (records.has(id)) continue;
    records.set(id, { id, file: path.join(absolute, name), relative: `${base}/${name}`, layout: 'flat' });
  }

  const out = [];
  for (const found of records.values()) {
    let summary = { id: found.id, path: found.relative, layout: found.layout };
    try {
      const parsed = parseSession(fs.readFileSync(found.file, 'utf-8'));
      summary = {
        ...summary,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        model: parsed.model,
        // The version that wrote it (`docs/runtime/session-version`), carried in the
        // listing so the picker can mark a session this build may not open *without*
        // loading its chunks: a locked row is still shown, it is just not enterable.
        monchoVersion: parsed.monchoVersion ?? null,
        counts: parsed.counts || { chunks: parsed.chunks.length, roles: countRoles(parsed.chunks) },
        stats: parsed.stats || {},
        bytes: fs.statSync(found.file).size,
      };
    } catch (error) {
      summary = { ...summary, error: error.code || 'INVALID_SESSION', message: error.message };
    }
    out.push(summary);
  }

  // Date-named ids sort lexicographically, newest first. A record that cannot be read
  // never tops the picker: it is listed last instead.
  return out.sort((a, b) => {
    if (Boolean(a.error) !== Boolean(b.error)) return a.error ? 1 : -1;
    return String(b.id).localeCompare(String(a.id));
  });
}

/**
 * Load one session by id: the folder record first, then the flat file the older
 * layout wrote, so a conversation stored before the folder existed still resumes.
 * Throws a coded error when neither exists or the record is malformed.
 */
export function loadSession(id, { dir = SESSION_DIR } = {}) {
  const candidates = [sessionPath(id, { dir }), legacySessionPath(id, { dir })];
  for (const relative of candidates) {
    let absolute;
    try {
      absolute = resolveProjectPath(relative);
    } catch {
      continue;
    }
    if (!fs.existsSync(absolute)) continue;
    return parseSession(fs.readFileSync(absolute, 'utf-8'));
  }
  throw new SessionStoreError('NOT_FOUND', `No session stored at ${candidates[0]}.`, { id });
}

/**
 * Move a session stored by the older layout into its folder.
 *
 * `writeSession()` already does this implicitly on the next save; this is the explicit
 * form for a caller that wants every stored conversation on the current layout (the
 * session picker reading an old tree, a test of the migration).
 *
 * @returns {boolean} true when a flat file was moved, false when there was nothing to do
 */
export function migrateSession(id, { dir = SESSION_DIR } = {}) {
  const legacy = resolveProjectPath(legacySessionPath(id, { dir }));
  if (!fs.existsSync(legacy)) return false;

  // Read before writing: the bytes are re-laid-out, never re-serialised from a guess.
  const record = parseSession(fs.readFileSync(legacy, 'utf-8'));
  writeFileVerified(sessionPath(id, { dir }), formatSession(record));
  fs.unlinkSync(legacy);
  return true;
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

/**
 * One line describing a summary, for the session picker.
 *
 * A session this build may not open is **marked, never hidden**: a row that silently
 * disappears is indistinguishable from a conversation that was lost, and the user needs
 * to see that the history is still there and why it cannot be entered
 * (`docs/runtime/session-version`).
 *
 * @param {object} summary a listing entry from `listSessions()`
 * @param {string} [version] the running version, when the caller wants the mark
 */
export function describeSession(summary, version = undefined) {
  if (!summary) return '';
  if (summary.error) return `${summary.id} — unreadable (${summary.error})`;
  const when = summary.updatedAt || summary.createdAt || '';
  const turns = summary.counts?.roles?.user ?? 0;
  const chunks = summary.counts?.chunks ?? 0;
  const model = summary.model ? ` · ${summary.model}` : '';
  const locked = version !== undefined && !canOpenSession(summary, version)
    ? ` · locked (${summary.monchoVersion})`
    : '';
  return `${summary.id} — ${turns} turn(s), ${chunks} chunk(s)${model} · ${when}${locked}`;
}