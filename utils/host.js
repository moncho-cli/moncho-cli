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

// ---------------------------------------------------------------------------
// Tracking announcements (app/tracking-notice.js)
// ---------------------------------------------------------------------------
// `update_task` rewrites the two tracking files from inside a tool call, so the one
// place that can turn that write into a transcript line is this registry: main.js
// registers a sink bound to the front end, and the tool reports the update. With no
// sink registered (a bare tool call, the tool-level tests) the report is a no-op.

let trackingNotifier = null;

/** Register the sink that announces a tracking update (called by main.js). */
export function registerTrackingNotifier(notifier) {
  trackingNotifier = notifier;
  return trackingNotifier;
}

/**
 * Announce one tracking update to the transcript.
 * @returns {string[]} the lines shown, empty when nothing is registered
 */
export function notifyTrackingUpdate(update) {
  if (!trackingNotifier || typeof trackingNotifier.notify !== 'function') return [];
  return trackingNotifier.notify(update) || [];
}

export function clearTrackingNotifier() {
  trackingNotifier = null;
}

// ---------------------------------------------------------------------------
// The operational log (utils/logger.js)
// ---------------------------------------------------------------------------
// The logger is built once at startup, in main.js, and registered here so a deep
// module (`api/ollama.js`, `app/turn-runner.js`, `app/tool-batch.js`) can record an
// event without being handed an object it has no other use for. With nothing
// registered — a unit test, a bare tool call — `logEvent()` is a silent no-op that
// creates no file, which is what keeps the suites free of side effects.

let logger = null;

/** Register the live logger (called by main.js). */
export function registerLogger(instance) {
  logger = instance || null;
  return logger;
}

/** @returns {import('./logger.js').Logger|null} */
export function getLogger() {
  return logger;
}

export function clearLogger() {
  logger = null;
}

// ---------------------------------------------------------------------------
// Session registry (session-specific task/plan files)
// ---------------------------------------------------------------------------
let currentSession = null;

/**
 * Register the active session (called when a session is adopted or created).
 *
 * The checklist is optional: a session opened without one still registers and
 * `getSessionTaskContent()` answers null for it. A session that carries one keeps
 * it in the session record, so a resumed conversation starts with the checklist it
 * was left with (`/sessions` hands both back when it resumes one).
 */
export function registerSession(session, taskContent = null, planContent = null) {
  currentSession = session;
  if (session && typeof session === 'object') {
    if (taskContent != null) session.taskContent = taskContent;
    if (planContent != null) session.planContent = planContent;
  }
  return currentSession;
}

/** @returns {object|null} The current session object with taskContent and planContent. */
export function getSession() {
  return currentSession;
}

/** Clear the current session. */
export function clearSession() {
  currentSession = null;
}

/** Get the task.md content for the current session, or null. */
export function getSessionTaskContent() {
  return currentSession?.taskContent || null;
}

/** Get the implementation_plan.md content for the current session, or null. */
export function getSessionPlanContent() {
  return currentSession?.planContent || null;
}

/** Update the task.md content for the current session. */
export function setSessionTaskContent(content) {
  if (currentSession) currentSession.taskContent = content;
}

/** Update the implementation_plan.md content for the current session. */
export function setSessionPlanContent(content) {
  if (currentSession) currentSession.planContent = content;
}