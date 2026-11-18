/**
 * Minimal in-process registry that lets stateless tools reach live harness state.
 *
 * Tools are plain functions with JSON arguments, so they cannot be handed object
 * references through a call. Any stateful component (currently the ContextWindow
 * used by task.md item 8) registers itself here at startup and the corresponding
 * tool reads it at call time.
 */

let contextWindow = null;

/** Register the active context window (called by main.js). */
export function registerContextWindow(window) {
  contextWindow = window;
  return contextWindow;
}

/** @returns {import('../app/context-window.js').ContextWindow|null} */
export function getContextWindow() {
  return contextWindow;
}

export function clearContextWindow() {
  contextWindow = null;
}
