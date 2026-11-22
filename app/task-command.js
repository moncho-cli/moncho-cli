import { readTaskContent, readPlanContent, trackingPaths } from '../utils/tracking-store.js';
import { TRACKING_FILE_NAMES } from '../utils/tracking-store.js';

/**
 * `/task` — show the session's own tracking pair, as it is, without leaving the prompt.
 *
 * The conversation's checklist and plan are the two files the user has to check while
 * working (`docs/agent/task-tracking`), and until now seeing them meant leaving the TUI
 * or remembering the session folder. This command opens them in a **read-only** modal
 * (`app/content-modal.js`): the text is verbatim, nothing can be edited from there, and
 * the files are the ones the tools are writing.
 *
 * Three decisions:
 *
 *  - **it reads, it never writes.** No `ensureTrackingFiles()` call: a session whose pair
 *    went missing must not have it silently re-seeded by a command the user typed to
 *    *look*. A missing file is reported as missing.
 *  - **the same source the tools use.** `readTaskContent()` / `readPlanContent()`
 *    (`utils/tracking-store.js`) are the file-then-record reads the tracking tools share,
 *    so what the modal shows is what the next `update_task` call will see — not a second
 *    reading of the folder with its own rules.
 *  - **the front end decides how to show it.** The command returns the documents and the
 *    result; the host opens the modal when it has one (`ctx.contentView`) and prints the
 *    lines when it does not. A line CLI still gets the content, so `/task` is never a
 *    no-op on a front end without a screen.
 *
 * A bare `/task` shows both documents. `/task task` or `/task plan` shows one, for the
 * case where the user knows which one they want to check.
 */

/** The two documents, in the order they are shown. */
export const TASK_DOCUMENTS = Object.freeze(['task', 'plan']);

/** The display name of each document. */
const DOCUMENT_NAMES = Object.freeze({
  task: TRACKING_FILE_NAMES.task,
  plan: TRACKING_FILE_NAMES.plan,
});

/**
 * Which documents a request asks for.
 *
 * @param {string} arg the command's argument
 * @returns {{kinds: string[], error: string|null}} the documents to show
 */
export function parseTaskArg(arg = '') {
  const text = String(arg ?? '').trim().toLowerCase();
  if (text === '') return { kinds: [...TASK_DOCUMENTS], error: null };
  if (text === 'task' || text === 'task.md') return { kinds: ['task'], error: null };
  if (text === 'plan' || text === 'implementation_plan.md' || text === 'implementation-plan.md') {
    return { kinds: ['plan'], error: null };
  }
  return { kinds: [], error: `"${arg}" is not a document. Use /task, /task task or /task plan.` };
}

/**
 * Read the documents the request names, as they are on disk.
 *
 * @param {string[]} kinds which documents to read
 * @returns {Array<{kind: string, name: string, path: string|null, text: string|null}>}
 */
export function readDocuments(kinds = TASK_DOCUMENTS) {
  const paths = trackingPaths();
  return kinds.map((kind) => {
    const text = kind === 'task' ? readTaskContent() : readPlanContent();
    return {
      kind,
      name: DOCUMENT_NAMES[kind],
      path: paths[kind] ?? null,
      text: typeof text === 'string' ? text : null,
    };
  });
}

/** `/task [task|plan]` — show the session's tracking files. */
export function taskCommand() {
  return {
    name: 'task',
    description: 'show this session\'s task.md and implementation_plan.md in a read-only modal',
    async run(ctx = {}) {
      const parsed = parseTaskArg(ctx.arg);
      if (parsed.error) {
        return { ok: false, code: 'UNKNOWN_ARG', message: parsed.error };
      }

      const documents = readDocuments(parsed.kinds);
      const missing = documents.filter((doc) => doc.text === null);

      if (missing.length === documents.length) {
        return {
          ok: false,
          code: 'NO_TRACKING',
          message: 'This session has no tracking files yet. They are created when the session starts.',
        };
      }

      // The documents with content, in the order they were asked for. A missing one is
      // named in the result rather than shown as an empty box.
      const shown = documents.filter((doc) => doc.text !== null);
      const view = {
        title: 'Task',
        documents: shown.map((doc) => ({ name: doc.name, path: doc.path, text: doc.text })),
      };

      // A front end with a screen opens the read-only modal; one without gets the lines.
      if (typeof ctx.contentView === 'function') {
        const closed = await ctx.contentView(view);
        return {
          ok: true,
          code: 'VIEWED',
          documents: shown.map((doc) => ({ name: doc.name, path: doc.path })),
          missing: missing.map((doc) => doc.name),
          closed: closed?.closed ?? null,
        };
      }

      const lines = [];
      for (const doc of shown) {
        lines.push(`[${doc.name}]${doc.path ? ` ${doc.path}` : ''}`);
        lines.push(...doc.text.split('\n'));
      }
      if (missing.length) {
        lines.push(`Not found: ${missing.map((doc) => doc.name).join(', ')}`);
      }
      return {
        ok: true,
        code: 'LISTED',
        lines,
        documents: shown.map((doc) => ({ name: doc.name, path: doc.path })),
        missing: missing.map((doc) => doc.name),
      };
    },
  };
}
