import { getSession } from './host.js';
import { trackingPaths } from './tracking-store.js';
import { sessionPath } from './session-store.js';

/**
 * The conversation's own identity, handed to the model on every request.
 *
 * The host has always known *where* a conversation lives — its id, its folder under
 * `agent/sessions/`, its `task.md`, its plan and its `context.json` — and the model
 * never did. It only learned the paths from an `update_task` reply, so before the first
 * tracking call it had nothing to go on and would grep the tree for the folder it was
 * already sitting in (task-backlog item 51).
 *
 * This module closes that gap with **one system message per request**, assembled from
 * the live session registry and never stored as a chunk:
 *
 *  - it is *host data*, not conversation, so it belongs in the request prelude
 *    (`app/context-window.js#ContextWindow.request`) next to the pulse line, not in the
 *    window the session record snapshots;
 *  - it is **constant for the whole session** — the id and the folder do not change
 *    between turns, and a resumed conversation keeps the folder it came from — so the
 *    request prefix stays byte-identical and a provider prompt cache still hits;
 *  - with **no session registered** it answers `null`, so a bare tool invocation or a
 *    stub session sends exactly what it sent before.
 *
 * The paths are stated *resolved*, never as a pattern to compute: a fresh session's id
 * did not exist when the prompt was written, and a resumed one may live elsewhere. That
 * is the same reason `update_task` reports resolved paths — and now the model is told
 * once, up front, instead of having to guess or scan.
 */

/** The marker the block starts with, so a reader can recognise it in a request. */
export const SESSION_MARKER = '[session]';

/**
 * Render the block for one session, or the empty string when it cannot be resolved.
 *
 * Pure: it takes the facts and answers text, so the wording is unit-testable without a
 * registry or a filesystem.
 *
 * @param {{id?: string, folder?: string, task?: string, plan?: string, record?: string}} session
 * @returns {string} the message content, or `''` when a path is missing
 */
export function formatSessionBlock({ id, folder, task, plan, record } = {}) {
  if (!id || !folder || !task || !plan) return '';
  return [
    `${SESSION_MARKER} this conversation's own folder is ${folder}/ — your session id is ${id}.`,
    'These files are yours and already exist there; never grep or scan the tree to find them:',
    `- task.md: ${task}`,
    `- implementation_plan.md: ${plan}`,
    ...(record ? [`- conversation record: ${record}`] : []),
    'The folder is fixed for the whole conversation: it does not change between turns, and'
      + ' resuming a stored conversation keeps the folder it came from. update_task reports'
      + ' these same paths on every reply.',
  ].join('\n');
}

/**
 * The `system` message the request carries, or `null` when there is no session.
 *
 * The sessions directory is taken from the recorder when it names one, so an injected
 * directory (the tests, a non-default `SESSION_DIR`) resolves the same paths the
 * tracking store reads and writes.
 *
 * @returns {{role: 'system', content: string}|null}
 */
export function sessionBlockMessage() {
  const session = getSession();
  const id = session?.id;
  if (!id) return null;
  const dir = typeof session.dir === 'string' && session.dir ? session.dir : null;
  const paths = trackingPaths(dir ? { dir } : {});
  if (!paths.folder) return null;
  const record = typeof session.path === 'string' && session.path
    ? session.path
    : sessionPath(id, dir ? { dir } : {});
  const content = formatSessionBlock({
    id,
    folder: paths.folder,
    task: paths.task,
    plan: paths.plan,
    record,
  });
  return content ? { role: 'system', content } : null;
}
