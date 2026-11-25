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
import { runningVersion, sessionVerdict, sessionVersion, upgradedPin } from './session-version.js';
import { migrateRecord } from './session-compat.js';

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

/**
 * Carry a stored session forward across the declared compatibility breaks
 * (`docs/runtime/session-compat`).
 *
 * This is the write half of the era rule. The gate decides *whether* a session opens
 * (`sessionVerdict()`); this does the part that decision deferred — run the migrations the
 * breaks name, in order, and re-stamp the pin so the record now belongs to `version`.
 *
 * Three things make it a different operation from `writeSession()`:
 *
 *  - **it reads raw JSON, not `parseSession()`.** The bytes a migration exists to fix are
 *    exactly the ones this build's validator may refuse — a future shape, an unknown
 *    format version — so validating first would refuse the record before the function
 *    written to fix it could see it.
 *  - **it never re-serialises through `serializeSession()`.** That builder keeps only the
 *    fields it knows, so a round-trip would drop anything a migration added. The migrated
 *    object is written as it stands, with the pin merged in.
 *  - **the pin is rewritten with `upgradedPin()`**, so the move carries the audit line and
 *    the old build refuses the session afterwards — the same rewrite `/upgrade` performs,
 *    for the case where the user never had to know.
 *
 * All-or-nothing: a broken or missing migration answers `migrated: false` and writes
 * nothing, so the session is left exactly as it was for the refusal to report.
 *
 * @returns {{migrated: boolean, code: string, verdict: object, record: object,
 *   applied?: string[], from?: string|null, blocked?: object|null, error?: Error|null}}
 */
export function migrateStoredSession(id, { dir = SESSION_DIR, version = runningVersion(), now = new Date(), options = {} } = {}) {
  const candidates = [sessionPath(id, { dir }), legacySessionPath(id, { dir })];
  let raw = null;
  for (const relative of candidates) {
    try {
      const absolute = resolveProjectPath(relative);
      if (!fs.existsSync(absolute)) continue;
      raw = fs.readFileSync(absolute, 'utf-8');
      break;
    } catch {
      continue;
    }
  }
  if (raw === null) {
    throw new SessionStoreError('NOT_FOUND', `No session stored at ${candidates[0]}.`, { id });
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch (error) {
    throw new SessionStoreError('INVALID_JSON', `Session file is not valid JSON: ${error.message}`, { id });
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new SessionStoreError('INVALID_SESSION', 'Session file must hold a JSON object.', { id });
  }

  const verdict = sessionVerdict(record, version, options);
  if (verdict.verdict !== 'migrate') {
    return {
      migrated: false,
      code: verdict.verdict === 'refuse' ? 'VERSION_LOCKED' : 'UP_TO_DATE',
      verdict,
      record,
    };
  }

  const result = migrateRecord(record, verdict.steps, options);
  if (!result.ok) {
    return { migrated: false, code: 'MIGRATION_FAILED', verdict, record, blocked: result.blocked, error: result.error };
  }

  const pin = upgradedPin(sessionVersion(record), version, now);
  const next = { ...result.record, ...pin };
  writeFileVerified(sessionPath(id, { dir }), formatSession(next));

  // A flat file left by the older layout is stale the moment the record lands in its
  // folder — the same retirement `writeSession()` performs.
  try {
    const legacy = resolveProjectPath(legacySessionPath(id, { dir }));
    if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
  } catch {
    // Housekeeping: it must never fail a good migration.
  }

  return { migrated: true, code: 'MIGRATED', verdict, record: next, applied: result.applied, from: pin.upgradedFrom };
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
 * The three answers are told apart, because they are three different situations: a locked
 * row cannot be entered at all, a row **needing upgrade** opens once its bytes are carried
 * forward (`docs/runtime/session-compat`), and a row this build owns carries no mark.
 *
 * @param {object} summary a listing entry from `listSessions()`
 * @param {string} [version] the running version, when the caller wants the mark
 * @param {{breaks?: object[], migrations?: object}} [options] the break list under test
 */
export function describeSession(summary, version = undefined, options = {}) {
  if (!summary) return '';
  if (summary.error) return `${summary.id} — unreadable (${summary.error})`;
  const when = summary.updatedAt || summary.createdAt || '';
  const turns = summary.counts?.roles?.user ?? 0;
  const chunks = summary.counts?.chunks ?? 0;
  const model = summary.model ? ` · ${summary.model}` : '';
  const verdict = version === undefined ? null : sessionVerdict(summary, version, options);
  const mark = verdict === null || verdict.verdict === 'open'
    ? ''
    : verdict.verdict === 'refuse'
      ? ` · locked (${summary.monchoVersion})`
      : ` · upgrade (${summary.monchoVersion})`;
  return `${summary.id} — ${turns} turn(s), ${chunks} chunk(s)${model} · ${when}${mark}`;
}