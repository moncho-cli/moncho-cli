/**
 * The one thing the host loop still has to notice about a tool *result*.
 *
 * `compact_context` runs as an ordinary tool, but it cannot compact the window
 * itself: the window is being read by the request that is in flight. So the tool
 * answers with a request instead of an action, and the loop performs the
 * compaction once the turn is back under its control
 * (`app/conversation-manager.js#maybeCompact`).
 *
 * Kept apart from the loop so the marker is a pure string check — a tool result
 * is arbitrary text, and a malformed one must read as "no request", never throw.
 */

/** Result code `compact_context` uses to defer the work to the host loop. */
export const COMPACTION_REQUEST_CODE = 'COMPACTION_REQUESTED';

/** True when a compact_context result asks the host loop to run a compaction. */
export function detectCompactionRequest(result) {
  if (typeof result !== 'string') return false;
  try {
    const parsed = JSON.parse(result);
    return parsed?.code === COMPACTION_REQUEST_CODE && parsed?.defer === true;
  } catch {
    return false;
  }
}