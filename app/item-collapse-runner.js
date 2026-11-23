import { getContextWindow, getSession, notifyCollapse } from '../utils/host.js';
import { writeChunkpactionCapture } from '../utils/chunkpaction-store.js';

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
 */

/**
 * Collapse the sections of the items that are done, keeping their raw chunks.
 *
 * @param {Iterable<string>} completed the items `task.md` reports as done
 * @returns {{collapsed: object[], chunks: number}|null} the report, or `null` when there
 *   is no window or no session to collapse into
 */
export function runItemCollapse(completed = []) {
  const window = getContextWindow();
  if (!window || typeof window.collapseCompleted !== 'function') return null;

  const session = getSession();
  if (!session?.id) return null;

  const report = window.collapseCompleted({
    completed,
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
