import { TASK_FILE, PLAN_FILE } from '../config/constants.js';
import { canonicalizeTrackingFile } from './tracking-format.js';
import { SESSION_DIR } from './session-store.js';

/**
 * The fence around the two tracking files (`docs/agent/task-tracking`).
 *
 * `task.md` and `implementation_plan.md` have a **fixed shape** (`utils/tracking-format.js`)
 * and one tool that owns the loop (`update_task`). The generic writers are therefore not
 * allowed to put arbitrary bytes in them, and the two tools answer differently because
 * the two operations are different in kind:
 *
 *  - **`write_file` re-renders.** Handing it a checklist is a legitimate way to author
 *    one — a `design` session has no `add` action to grow a list from — so the content is
 *    accepted and immediately replaced by the canonical document built from it. The model
 *    cannot produce a malformed file; it can only produce a *draft* that is normalised.
 *  - **`edit_file` is refused.** A region change into a document the harness re-renders is
 *    never the right move: its hunks would be undone by the next `update_task` call, so
 *    the refusal names the tool to use instead.
 *
 * The name comparison is what makes `edit_file` and `delete_file` answer in any folder,
 * because a stray copy is still a document they must not touch. `write_file` is the one
 * tool that could *create* one, so it is stricter still: a tracking name is accepted
 * **only** under `agent/sessions/<id>/` and refused anywhere else, root included. The
 * pair belongs to a conversation (`utils/tracking-store.js`), so a root `task.md` is not
 * a checklist that lost its session — it is a file the harness must not create.
 */

/** The file names the harness owns, whichever folder they sit in. */
export const TOOL_OWNED_FILES = Object.freeze([TASK_FILE, PLAN_FILE]);

/** The tool that owns the tracking loop. */
export const TRACKING_TOOL = 'update_task';

/** The stable code a refused patch comes back with. */
export const TRACKING_FILE_REFUSAL = 'TRACKING_FILE_TOOL_OWNED';

/** The stable code for a tracking name outside a session folder. */
export const TRACKING_LOCATION_REFUSAL = 'TRACKING_FILE_NOT_IN_SESSION';

/** The path's segments, with `\` accepted as a separator and `.`/empty dropped. */
function segmentsOf(value) {
  return String(value ?? '').trim().replace(/\\/g, '/').split('/')
    .filter((part) => part !== '' && part !== '.');
}

/** The last path segment, with `\` accepted as a separator. */
function basename(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/');
  if (raw === '') return '';
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');
  return parts.length === 0 ? '' : parts[parts.length - 1];
}

/** True when `path` names one of the tracking files the harness owns. */
export function isToolOwnedFile(path) {
  const name = basename(path);
  return name !== '' && TOOL_OWNED_FILES.includes(name);
}

/**
 * True when `path` names a tracking file **inside** a session folder:
 * `agent/sessions/<id>/task.md`, one folder deep and nothing deeper.
 */
export function isSessionTrackingPath(path) {
  const parts = segmentsOf(path);
  const prefix = segmentsOf(SESSION_DIR);
  if (parts.length !== prefix.length + 2) return false;
  if (!prefix.every((segment, i) => parts[i] === segment)) return false;
  return parts[parts.length - 2] !== '' && TOOL_OWNED_FILES.includes(parts[parts.length - 1]);
}

/**
 * The refusal for a write that would put a tracking file outside a session folder.
 *
 * `write_file` is the only writer that can create one, so it is the only caller, but the
 * rule is the protocol's: the pair belongs to a conversation, so the project root is not
 * a place either file may appear (`docs/agent/task-tracking`).
 *
 * @param {string} path the path argument of the call
 * @returns {object|null} the refusal, or `null` when the path is fine (or not tracking)
 */
export function trackingLocationRefusal(path) {
  const kind = toolOwnedKind(path);
  if (!kind) return null;
  if (isSessionTrackingPath(path)) return null;
  return {
    status: 'error',
    code: TRACKING_LOCATION_REFUSAL,
    message:
      `${basename(path)} belongs to the conversation working through it, not to the project, so a `
      + `copy at "${path}" is never created.`,
    guidance:
      `Call ${TRACKING_TOOL} instead — every reply of its names the paths to use `
      + '(`action: "list"` to read, `"start"`/`"complete"` with `steps` to write).',
    path,
  };
}

/** `'task'` or `'plan'` for a tracking path, `null` for anything else. */
export function toolOwnedKind(path) {
  const name = basename(path);
  if (name === TASK_FILE) return 'task';
  if (name === PLAN_FILE) return 'plan';
  return null;
}

/**
 * The canonical bytes a `write_file` call on a tracking path really stores.
 *
 * Whatever the caller supplied is parsed and re-rendered, so a hand-written draft, a
 * legacy bare list and an already-canonical document all land as the same shape. Notes
 * and the title survive; only the arrangement is normalised.
 *
 * @param {string} path the path argument of the call
 * @param {string} content what the caller asked to write
 * @returns {{content: string, kind: 'task'|'plan'}|null} the normalised content, or null
 *   when the path is not a tracking file (the caller writes it verbatim)
 */
export function canonicalTrackingWrite(path, content) {
  const kind = toolOwnedKind(path);
  if (!kind) return null;
  const text = typeof content === 'string' ? content : '';
  return { kind, content: canonicalizeTrackingFile(kind, text) };
}

/**
 * The refusal for a `patch_file`-shaped call (`edit_file` with `patchStr`), or `null`.
 *
 * @param {string} path the path argument of the call
 * @returns {{status: string, code: string, message: string, guidance: string, path: string}|null}
 */
export function trackingFenceRefusal(path) {
  const kind = toolOwnedKind(path);
  if (!kind) return null;
  return {
    status: 'error',
    code: TRACKING_FILE_REFUSAL,
    message:
      `${basename(path)} is rewritten whole by ${TRACKING_TOOL}: a patch into a document the `
      + 'harness re-renders would be undone by the next tracking call.',
    guidance:
      `Use ${TRACKING_TOOL} instead (\`action: "list"\` to read, \`"start"\`/\`"complete"\` with `
      + '`steps` to write, `"step"` to tick one step).',
    path,
  };
}

/**
 * The refusal for a `delete_file` call that names a tracking file, or `null`.
 *
 * The fence is symmetric: whichever generic writer is pointed at the two files, the
 * answer is the same — `update_task` owns them. Deleting one is worse than patching
 * it, so the refusal says why and names the tool that can change the list instead.
 *
 * @param {string} path the path argument of the call
 * @returns {{status: string, code: string, message: string, guidance: string, path: string}|null}
 */
export function trackingDeleteRefusal(path) {
  const kind = toolOwnedKind(path);
  if (!kind) return null;
  return {
    status: 'error',
    code: TRACKING_FILE_REFUSAL,
    message:
      `${basename(path)} is owned by ${TRACKING_TOOL}, so it is never deleted: the tracking `
      + 'loop keeps both files in place for the whole session.',
    guidance:
      `Use ${TRACKING_TOOL} to change the document instead (\`action: "complete"\` to move on, `
      + '`"status"` to mark the list done).',
    path,
  };
}

/**
 * The refusal for an `edit_file` call that names a tracking file, or `null`.
 *
 * The same rule as the patch above, said in the words of the other operation: a
 * search/replace into a document the harness re-renders is undone by the next
 * tracking call, because `update_task` writes the whole file rather than a region
 * of it. Both refusals answer with the same code, so a caller learns only one.
 *
 * @param {string} path the path argument of the call
 * @returns {{status: string, code: string, message: string, guidance: string, path: string}|null}
 */
export function trackingEditRefusal(path) {
  const kind = toolOwnedKind(path);
  if (!kind) return null;
  return {
    status: 'error',
    code: TRACKING_FILE_REFUSAL,
    message:
      `${basename(path)} is rewritten whole by ${TRACKING_TOOL}: an edit into a document the `
      + 'harness re-renders would be undone by the next tracking call.',
    guidance:
      `Use ${TRACKING_TOOL} instead (\`action: "list"\` to read, \`"start"\`/\`"complete"\` with `
      + '`steps` to write, `"step"` to tick one step).',
    path,
  };
}