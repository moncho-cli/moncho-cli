import { prettyPrintJson } from './json-display.js';
import { formatToolHeader, toolResultFailed } from './tool-call-format.js';
import { takeWriteCapture } from '../utils/write-journal.js';
import { writeDiffBlock } from './diff-view.js';

/**
 * How a tool result reaches the screen.
 *
 * In the TUI a tool result is a collapsible block: one header line carrying the call's
 * intent and the "X char response" size, expanded with a click. The line CLI has no
 * widget, so it prints the header and the payload plainly. The result is the same either
 * way — the model receives the raw bytes and the session file keeps them verbatim; only
 * the display is re-indented.
 *
 * The row's header ends with the ✓/✗ marker the call earned, so a glance tells a call
 * that went as expected from one that has to be retried (`toolResultFailed()`).
 *
 * A **file write** gets one row more (backlog item 53): the tool result says the bytes
 * landed, and the next block shows *what* changed, side by side with line numbers. It
 * is drawn from `utils/write-journal.js`, not from the result — the result is what the
 * model is billed for, so a diff carried there would cost the session on every later
 * call to paint one block. A capture that was never recorded (a shell edit, a write
 * from before this route existed) answers `null` and the block is simply absent, which
 * is the honest display: the row above still reports the result.
 *
 * Pure wiring: the sink is injected, so the shape is unit tested without a terminal.
 *
 * @param {object} options
 * @param {object} [options.tui] the TUI, or `null` for the line CLI
 * @param {Function} [options.log] the line sink the CLI fallback prints through
 * @param {Function} [options.width] the region's usable width in cells, for the layout
 * @param {Function} [options.takeCapture] the capture source, for the tests
 * @returns {Function} `(toolName, result, intent) => void`
 */
export function createToolEcho({
  tui = null,
  log = () => {},
  width = () => 0,
  takeCapture = takeWriteCapture,
} = {}) {
  return function echoToolResult(toolName, result, intent) {
    const body = prettyPrintJson(result);
    const header = formatToolHeader(toolName, intent, { failed: toolResultFailed(result) });
    if (tui) {
      tui.logBlock({ header, body });
      const diff = diffForPath(result, takeCapture, width);
      if (diff) tui.logBlock(diff);
      return;
    }
    log(header);
    log(body);
    log('');
  };
}

/**
 * The diff block a result earns, if any.
 *
 * A *failed* call changed nothing, and a call whose result names no path is not a
 * write, so both answer `null` without consulting the journal. The path is the one
 * the result reports (`write_file` and `edit_file` both return it), which is the same
 * string the writer filed its capture under.
 *
 * @param {*} result the tool's raw return value
 * @param {Function} takeCapture
 * @param {Function} width
 * @returns {?object} the block `app/transcript-view.js#logBlock` takes
 */
function diffForPath(result, takeCapture, width) {
  let parsed = null;
  try {
    parsed = typeof result === 'string' ? JSON.parse(result) : result;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.status !== 'success' || typeof parsed.path !== 'string') return null;
  if (typeof takeCapture !== 'function') return null;

  let capture = null;
  try {
    capture = takeCapture(parsed.path);
  } catch {
    // The journal is a convenience: a broken one costs the block, never the result.
    return null;
  }
  if (!capture) return null;

  const cells = typeof width === 'function' ? Number(width()) || 0 : 0;
  return writeDiffBlock(capture, { width: cells });
}
