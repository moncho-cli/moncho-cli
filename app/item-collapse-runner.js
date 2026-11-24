import { getContextWindow, getSession, notifyCollapse } from '../utils/host.js';
import { writeChunkpactionCapture } from '../utils/chunkpaction-store.js';
import { chunkpactionEnabled } from '../config/constants.js';

/**
 * Run the item collapse and persist what it replaced (`docs/context/item-collapse`,
 * `docs/context/chunkpaction`).
 *
 * This is the wiring half, and it lives apart from the rule for the same reason
 * `app/compaction-runner.js` lives apart from `utils/compaction.js`: the rule is pure
 * and unit tested on arrays, while *this* reaches the live window and the session folder,
 * which is exactly the pair a test does not want to arrange.
 *
 * Two things have to be true for a collapse to mean anything, and this module is where
 * they meet:
 *
 *  - the **window** holds the chunks and their attributions (`app/context-window.js`),
 *    so it is the only thing that can rewrite them;
 *  - the **capture** has to be written *before* the window is rewritten, because the
 *    summary it produces names the capture id. The writer is handed to the window rather
 *    than called here, so the ordering is the collapse's own and a writer that throws
 *    leaves the window untouched.
 *
 * With no window registered (a bare tool call, the tool-level suites) or no session (no
 * folder to write a capture into) it is a silent no-op, which is the same shape every
 * other registry-backed step has.
 *
 * ## Why the request is deferred to the batch
 *
 * `tools/update_task.js` completes an item from *inside* a tool call, and a tool call is
 * only half of what the batch appends: `app/tool-batch.js` writes the assistant chunk
 * carrying the `tool_calls` **before** the call runs and the `tool` result chunk **after**
 * it. Collapsing at the moment the tool finished would therefore be collapsing against a
 * window that is still missing half of the very section being collapsed — and the run it
 * would see ends on a tool call whose result has not been written yet, which is exactly the
 * shape the rule must refuse (`utils/item-collapse.js#cutsToolBatch`). So `update_task`
 * *asks* (`requestItemCollapse`) and the batch *runs it* once its chunks are all in
 * (`app/tool-batch.js`). One request is one collapse: a run that is never drained — no
 * batch around the call — collapses nothing, which is the honest report for a call made
 * outside a batch.
 */

/** The item-completion a tool asked for, waiting for the batch to finish appending. */
let pending = null;

/**
 * Ask for the finished item's section to be collapsed once the surrounding tool batch has
 * appended every chunk it owns.
 *
 * @param {Iterable<string>} completed the items `task.md` reports as done
 * @returns {boolean} true when the request was recorded for a live window and session
 */
export function requestItemCollapse(completed = []) {
  // The switch is read here, at the moment a collapse is asked for: off means the section
  // stays verbatim in the window and nothing is written to the capture file.
  if (!chunkpactionEnabled()) return false;
  const window = getContextWindow();
  if (!window || typeof window.collapseCompleted !== 'function') return false;
  if (!getSession()?.id) return false;

  pending = { completed: [...completed] };
  return true;
}

/**
 * Collapse the sections of the items that are done, keeping their raw chunks.
 *
 * Called by the tool batch after it has appended its own chunks, so the window it rewrites
 * holds the whole section — call chunk and result chunks alike. A no-op when nothing asked
 * for a collapse, so a batch without a completing `update_task` costs one null check.
 *
 * @returns {{collapsed: object[], chunks: number}|null} the report, or `null` when there was
 *   nothing to collapse (no request, no window, no session)
 */
export function runItemCollapse() {
  const request = pending;
  // Claimed *before* the window is touched, so a collapse that somehow re-enters (a capture
  // writer that appended a chunk, a nested batch) cannot run the same request twice.
  pending = null;
  if (!request) return null;
  // Re-checked at drain time as well as at request time: a switch turned off between the
  // call and its batch must not collapse against a window the user just asked to leave alone.
  if (!chunkpactionEnabled()) return null;

  const window = getContextWindow();
  if (!window || typeof window.collapseCompleted !== 'function') return null;

  const session = getSession();
  if (!session?.id) return null;

  const report = window.collapseCompleted({
    completed: request.completed,
    // The window calls this per collapsing run, before it rewrites itself, and the id it
    // answers is the one the summary will name.
    writeCapture: (run) => writeChunkpactionCapture(session.id, {
      item: run.item,
      chunks: run.chunks,
    }).entry,
  });

  // The user watches the conversation, and the window just shrank: the collapse is
  // announced like a compaction is, so the shrink is explained rather than mysterious.
  // Announced *after* the rewrite, because only a rewrite that happened is worth a line
  // — a collapse the guards refused shows nothing, which is also the honest report.
  // Presentation only: the line is not a chunk and never reaches the model.
  if (report && report.collapsed.length > 0) notifyCollapse(report);

  return report;
}

/**
 * Drop a request that will never be drained.
 *
 * Only a caller that deliberately ends a batch early needs this; the batch itself always
 * drains, so in the live loop the request is never left behind.
 */
export function clearItemCollapseRequest() {
  pending = null;
}
