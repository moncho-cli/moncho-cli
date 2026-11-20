import { TASK_FILE, PLAN_FILE } from '../config/constants.js';
import { FileIOError, readFileIfExists, writeFileVerified } from './file-io.js';
import {
  getSession,
  getSessionTaskContent,
  getSessionPlanContent,
  setSessionTaskContent,
  setSessionPlanContent,
} from './host.js';
import { sessionDir } from './session-store.js';
import { canonicalizeTrackingFile } from './tracking-format.js';

/**
 * *Where* the two tracking files live, and the one rule that decides it.
 *
 * A checklist belongs to the conversation that is working through it, so each session
 * owns its own pair under its folder:
 *
 *     agent/sessions/<session-id>/task.md
 *     agent/sessions/<session-id>/implementation_plan.md
 *
 * The `agent/` tree is gitignored, so a checklist never ships in a commit, and two
 * sessions over the same repository never fight over one file. A tool call with **no**
 * session registered — a bare tool invocation, which is what the tool-level suites
 * drive — has no store at all: `trackingPaths()` answers `null` paths, every read
 * answers `null`, and a write throws `NO_SESSION`.
 *
 * There is deliberately **no project-root fallback**. The pair is a property of a
 * conversation, so a root `task.md` is never read as one and can never be created: a
 * tree file that carried one was an artefact of the old flat layout, and a `[Tracking]`
 * write against a session-less process used to resurrect it. The root is the operator's
 * and the harness keeps nothing there.
 *
 * Two sources, consulted in this order and never a third:
 *
 *  1. the **session file** — the copy a human can hot-edit, the escape hatch
 *     `docs/interface/modes` names;
 *  2. the **session record** — the snapshot inside `<session-id>/context.json`, used
 *     only when the file is gone (a resumed conversation whose folder was cleaned).
 *
 * Writes always land in the session file and are mirrored into the session record, so a
 * resumed conversation is self-contained. Every byte written comes from
 * `utils/tracking-format.js`, so what lands on disk is always the canonical shape.
 */

/** The base name of each tracking file, whichever folder owns it. */
export const TRACKING_FILE_NAMES = Object.freeze({ task: TASK_FILE, plan: PLAN_FILE });

/**
 * The two paths the current session reads and writes.
 * @param {{dir?: string}} [options] the sessions directory (injectable for tests)
 * @returns {{task: string, plan: string, folder: string|null}} project-relative paths
 */
export function trackingPaths({ dir = null } = {}) {
  const id = getSession()?.id;
  // No session: no store. Never the project root — that pair belongs to nobody.
  if (!id) return { task: null, plan: null, folder: null };
  const folder = sessionDir(id, dir ? { dir } : {});
  return { task: `${folder}/${TASK_FILE}`, plan: `${folder}/${PLAN_FILE}`, folder };
}

/** The checklist of the current session, or `null` when there is none at all. */
export function readTaskContent(readFile = readFileIfExists) {
  return readTracking('task', readFile);
}

/** The plan of the current session, or `null` when there is none at all. */
export function readPlanContent(readFile = readFileIfExists) {
  return readTracking('plan', readFile);
}

/** The file first (it is what a human edits), then the record snapshot. */
function readTracking(kind, readFile) {
  const path = trackingPaths()[kind];
  // An injected reader *is* the store: it decides what the checklist of this call is
  // (the drive and `/work` are tested that way). The project's own reader is only ever
  // pointed inside a session folder, because the root is not one.
  if (!path && readFile === readFileIfExists) return null;
  const fromFile = readFile(path);
  if (typeof fromFile === 'string') return fromFile;
  const snapshot = kind === 'task' ? getSessionTaskContent() : getSessionPlanContent();
  return typeof snapshot === 'string' && snapshot !== '' ? snapshot : null;
}

/**
 * Write the checklist: the session file, then the record snapshot.
 * @returns {{path: string, verified: true}} the write report
 */
export function writeTaskContent(content) {
  return writeTracking('task', content, setSessionTaskContent);
}

/** Write the plan: the session file, then the record snapshot. */
export function writePlanContent(content) {
  return writeTracking('plan', content, setSessionPlanContent);
}

function writeTracking(kind, content, setSessionContent) {
  const path = trackingPaths()[kind];
  // The invariant behind the whole module: a checklist is written inside a session
  // folder or not at all, so nothing can ever create `task.md` in the project tree.
  if (!path) {
    throw new FileIOError(
      'NO_SESSION',
      `There is no session to own ${TRACKING_FILE_NAMES[kind]}: the tracking pair lives in `
        + 'agent/sessions/<id>/, never at the project root.',
    );
  }
  const written = writeFileVerified(path, content);
  setSessionContent(content);
  return { ...written, path };
}

/**
 * Make sure the session folder owns a canonical pair of files.
 *
 * Called when a session is registered, and again on resume. A fresh session is **seeded**
 * from its canonical skeleton (an empty checklist); a resumed session is re-seeded from
 * its own record when its folder went missing. Either way the bytes are canonical, so a
 * legacy file is upgraded in place instead of being inherited as-is. No root file is
 * ever consulted: a checklist starts empty and is built by the conversation.
 *
 * @param {{readFile?: Function, dir?: string}} [options]
 * @returns {{task: string, plan: string, folder: string|null, created: string[]}}
 */
export function ensureTrackingFiles({ readFile = readFileIfExists, dir = null } = {}) {
  const paths = trackingPaths({ dir });
  // Seeding is a *session* affair: with no session registered there is no folder to
  // own the files, and creating them at the project root would be the opposite of the
  // point — the root pair is exactly what this move removed. A bare call is a no-op.
  if (paths.folder === null) return { ...paths, created: [] };

  const created = [];

  for (const kind of ['task', 'plan']) {
    if (typeof readFile(paths[kind]) === 'string') continue;
    writeFileVerified(paths[kind], canonicalizeTrackingFile(kind, seedOf(kind)));
    created.push(paths[kind]);
  }

  // Keep the record snapshot in step with the files it now owns.
  setSessionTaskContent(readFile(paths.task));
  setSessionPlanContent(readFile(paths.plan));

  return { ...paths, created };
}

/** What a new file starts from: the record snapshot, else `null` (the empty skeleton). */
function seedOf(kind) {
  const snapshot = kind === 'task' ? getSessionTaskContent() : getSessionPlanContent();
  return typeof snapshot === 'string' ? snapshot : null;
}