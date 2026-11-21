import { prettyPrintJson } from './json-display.js';

/**
 * How a tool result reaches the screen.
 *
 * In the TUI a tool result is a collapsible block: one header line carrying the call's
 * intent and the "X char response" size, expanded with a click. The line CLI has no
 * widget, so it prints the header and the payload plainly. The result is the same either
 * way — the model receives the raw bytes and the session file keeps them verbatim; only
 * the display is re-indented.
 *
 * Pure wiring: the sink is injected, so the shape is unit tested without a terminal.
 *
 * @param {object} options
 * @param {object} [options.tui] the TUI, or `null` for the line CLI
 * @param {Function} [options.log] the line sink the CLI fallback prints through
 * @returns {Function} `(toolName, result, intent) => void`
 */
export function createToolEcho({ tui = null, log = () => {} } = {}) {
  return function echoToolResult(toolName, result, intent) {
    const body = prettyPrintJson(result);
    const header = `\n  [${toolName} Output]${intent ? ` (intent: ${intent})` : ''}`;
    if (tui) {
      tui.logBlock({ header, body });
      return;
    }
    log(header);
    log(body);
    log('');
  };
}
