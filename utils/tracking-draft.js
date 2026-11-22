import { TASK_FILE, PLAN_FILE } from '../config/constants.js';
import { applyEditsToText, EditError } from './edit_lib.js';
import {
  readTaskContent, readPlanContent, writeTaskContent, writePlanContent, trackingPaths,
} from './tracking-store.js';
import { canonicalizeTrackingFile, validateTrackingFile } from './tracking-format.js';

/**
 * The two design-mode writers' shared half (`docs/interface/modes`).
 *
 * A `design` session authors exactly two documents — the checklist and the plan of its own
 * conversation — and it used to do it through the generic `write_file` / `edit_file`, whose
 * *path* the mode policy then had to police. That is the wrong shape: a policy that reads a
 * path and compares it against a pattern is a rule the model can be asked to respect, while
 * a tool that **takes no path at all** is one it cannot violate. So `design` is offered two
 * writers that name only *which* of the pair they touch:
 *
 *  - `write_plan_md` authors one of the two documents from a draft;
 *  - `edit_plan_md` changes one by literal search/replace.
 *
 * Neither can reach anything else, because the path is not an argument — it comes from
 * `utils/tracking-store.js#trackingPaths()`, the single place that decides where the pair of
 * the current session lives. That is the whole reason this module exists: the *scope* is a
 * property of the tool rather than a check the tool performs, so it cannot be talked around.
 *
 * Both entry points end the same way — **canonicalise, then write through the store** — so a
 * design session can never leave a malformed document behind, and the session file and the
 * record snapshot stay in step exactly as they do for `update_task` (`docs/agent/task-tracking`).
 *
 * A refusal is a structured value, never a thrown error, so a failed call cannot touch a file.
 * Pure in the parts that matter: the kind and the canonical bytes are values in, values out.
 */

/** The two kinds of tracking document, in the vocabulary a caller uses. */
export const TRACKING_KINDS = Object.freeze({ task: TASK_FILE, plan: PLAN_FILE });

/** The kind a call means when it names none: the plan, which is what design is for. */
export const DEFAULT_TRACKING_KIND = 'plan';

/**
 * Which of the two documents a call means.
 *
 * A caller may name the kind (`task`, `plan`) or the file itself (`task.md`,
 * `implementation_plan.md`), because both are how a person refers to them; anything else
 * answers `null`, which the tools turn into `INVALID_FILE`. Nothing is guessed: a typo
 * must not silently author the wrong document.
 *
 * @param {string} [value] the `file` argument of the call
 * @returns {'task'|'plan'|null}
 */
export function normalizeTrackingKind(value = DEFAULT_TRACKING_KIND) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === '') return DEFAULT_TRACKING_KIND;
  if (raw === 'task' || raw === TASK_FILE.toLowerCase()) return 'task';
  if (raw === 'plan' || raw === PLAN_FILE.toLowerCase()) return 'plan';
  return null;
}

/** The refusal the two tools answer with, in the shape every tool result uses. */
export function refusal(code, message, extra = {}) {
  return JSON.stringify({ status: 'error', code, message, ...extra });
}

/**
 * The refusal for a `file` argument that names neither document.
 * @param {string} value what the call supplied
 */
export function invalidFileRefusal(value) {
  return refusal(
    'INVALID_FILE',
    `${JSON.stringify(value ?? null)} does not name one of the two documents this tool writes.`,
    {
      guidance: `Pass "file": "task" or "file": "plan" (${TASK_FILE} and ${PLAN_FILE}).`,
      files: { task: TASK_FILE, plan: PLAN_FILE },
    },
  );
}

/** The refusal for a call with no session to own the pair. */
function noSessionRefusal(kind) {
  return refusal(
    'NO_SESSION',
    `There is no session to own ${TRACKING_KINDS[kind]}: the tracking pair lives in `
      + 'agent/sessions/<id>/, never at the project root.',
  );
}

/** Read the document of one kind, or `null` when the session has none. */
export function readTrackingDraft(kind) {
  return kind === 'plan' ? readPlanContent() : readTaskContent();
}

/** Write the document of one kind, through the store that owns the location. */
function writeTrackingDraft(kind, content) {
  return kind === 'plan' ? writePlanContent(content) : writeTaskContent(content);
}

/**
 * Author one of the session's two documents from a draft.
 *
 * Whatever the caller supplies is **re-rendered** into the canonical document
 * (`utils/tracking-format.js`), so a hand-written list, a bare set of checkboxes and an
 * already-canonical file all land in the same shape: a design session cannot produce a
 * malformed checklist, only a draft that is normalised.
 *
 * @param {{kind: 'task'|'plan', content: string}} input
 * @returns {string} the JSON tool result
 */
export function authorTrackingDraft({ kind, content }) {
  if (typeof content !== 'string') {
    return refusal('INVALID_CONTENT', 'The "content" argument must be a string.', {
      guidance: 'Pass the document you want to store as a string.',
    });
  }

  const paths = trackingPaths();
  if (!paths[kind]) return noSessionRefusal(kind);

  const canonical = canonicalizeTrackingFile(kind, content);
  const written = writeTrackingDraft(kind, canonical);
  const report = validateTrackingFile(canonical, { kind });

  return JSON.stringify({
    status: 'success',
    file: kind,
    path: written.path,
    bytes: written.bytes,
    created: written.created,
    verified: true,
    canonicalised: true,
    valid: report.ok,
    ...(report.ok ? {} : { problems: report.problems }),
    items: report.items.map((item) => ({ done: item.done, text: item.text })),
    message: `Wrote the ${kind} document (${TRACKING_KINDS[kind]}) at ${written.path}, re-rendered in its canonical shape.`,
  });
}

/**
 * Change one of the session's two documents by literal search/replace.
 *
 * The edits are applied by the same engine `edit_file` uses (`utils/edit_lib.js`), so a
 * missing, ambiguous or no-op search answers with the identical codes and diagnostics —
 * including the file's own bytes around a miss, so the next call is built from what is
 * really there. The difference is what happens next: the result is **re-canonicalised**
 * before it is written, so a region edit can never leave the document in a dialect the
 * harness would have to repair later.
 *
 * @param {{kind: 'task'|'plan', edits: object[]}} input
 * @returns {string} the JSON tool result
 */
export function editTrackingDraft({ kind, edits }) {
  const paths = trackingPaths();
  if (!paths[kind]) return noSessionRefusal(kind);

  const original = readTrackingDraft(kind);
  if (original === null) {
    return refusal(
      'FILE_NOT_FOUND',
      `There is no ${TRACKING_KINDS[kind]} for this session to edit yet.`,
      { guidance: `Author it first with the write tool (file: ${JSON.stringify(kind)}).` },
    );
  }

  let applied;
  try {
    applied = applyEditsToText(original, edits);
  } catch (error) {
    if (!(error instanceof EditError)) throw error;
    return JSON.stringify({
      status: 'error',
      code: error.code,
      message: error.message,
      ...(error.details || {}),
      file: kind,
    });
  }

  const canonical = canonicalizeTrackingFile(kind, applied.content);
  const written = writeTrackingDraft(kind, canonical);
  const replacements = applied.report.reduce((sum, entry) => sum + entry.replacements, 0);

  return JSON.stringify({
    status: 'success',
    file: kind,
    path: written.path,
    bytes: written.bytes,
    editsApplied: applied.report.length,
    replacements,
    verified: true,
    // True when the re-render moved the bytes the edits produced: an edit that broke the
    // document's shape is repaired rather than stored.
    canonicalised: canonical !== applied.content,
    valid: validateTrackingFile(canonical, { kind }).ok,
    edits: applied.report,
    message: `Applied ${applied.report.length} edit(s) making ${replacements} replacement(s) to the ${kind} document at ${written.path}.`,
  });
}
