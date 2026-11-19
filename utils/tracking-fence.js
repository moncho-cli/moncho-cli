import { TASK_FILE, PLAN_FILE } from '../config/constants.js';
import { canonicalizeTrackingFile } from './tracking-format.js';

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
 *  - **`patch_file` is refused.** A unified diff into a document the harness re-renders is
 *    never the right move: its hunks would be undone by the next `update_task` call, so
 *    the refusal names the tool to use instead.
 *
 * The comparison is on the file **name**, so the fence covers the session copies
 * (`agent/sessions/<id>/task.md`) exactly like a stray root file, and it needs no upkeep
 * when the folder policy changes (`utils/tracking-store.js`).
 */

/** The file names the harness owns, whichever folder they sit in. */
export const TOOL_OWNED_FILES = Object.freeze([TASK_FILE, PLAN_FILE]);

/** The tool that owns the tracking loop. */
export const TRACKING_TOOL = 'update_task';

/** The stable code a refused patch comes back with. */
export const TRACKING_FILE_REFUSAL = 'TRACKING_FILE_TOOL_OWNED';

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
 * The refusal for a `patch_file` call that names a tracking file, or `null`.
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