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

// ---------------------------------------------------------------------------
// The model-call pulse (utils/task-pulse.js)
// ---------------------------------------------------------------------------
// The pulse counts the agent model calls of the current stretch of work and
// resets when an item is completed or the window is compacted. The reset has to
// reach the *live* counter from a tool call (`update_task`), which is exactly the
// situation this registry exists for.

let taskPulse = null;

/** Register the live pulse (called by the ConversationManager). */
export function registerTaskPulse(pulse) {
  taskPulse = pulse;
  return taskPulse;
}

/** @returns {import('./task-pulse.js').TaskPulse|null} */
export function getTaskPulse() {
  return taskPulse;
}

/** Put the live pulse back to 0; false when there is none to reset. */
export function resetTaskPulse(reason = 'manual') {
  if (!taskPulse || typeof taskPulse.reset !== 'function') return false;
  taskPulse.reset(reason);
  return true;
}

export function clearTaskPulse() {
  taskPulse = null;
}

