import { PULSE_LIMIT, PULSE_LIMIT_DEFAULT } from '../config/constants.js';

/**
 * The model-call pulse (task-backlog: "keep in the context an incremental pulse on
 * each model call, create a hard limit configurable defaulting to 30, and instruct
 * via prompt.md to honor this value. reset it to 0 after marking an item as
 * completed or running compaction").
 *
 * One line, counting how many **agent** model calls the current stretch of work has
 * cost. The counter is **internal**: the line is paused (`formatPulseText`), so the
 * model only learns of it through the one notice raised at the crossing.
 *
 * Three decisions this module fixes:
 *
 *  - **the line is generated per call, never stored as a chunk.** A chunk would
 *    need one entry per call, so N calls would cost N lines of context forever, and
 *    a chunk could land between an assistant `tool_calls` message and its `tool`
 *    results — a window the provider pairs strictly. The line is therefore the
 *    second message of the request, replaced on every call: the model always sees
 *    the *current* count, and a recorded session stays the conversation itself
 *    (`docs/runtime/session-store`).
 *  - **the limit is instructive, not enforcing.** The backlog asks `prompt.md` to
 *    make the model honour the value. Refusing the call beyond it would deadlock the
 *    turn — the model is only able to reset the pulse *by calling a tool*. So the
 *    count keeps climbing, the wording turns imperative past the cap, and the host
 *    raises one transient notice the moment it is crossed.
 *  - **a call is counted when it is about to be sent**, so the line the model reads
 *    names the very call it rides on ("model call 4 of 30").
 *
 * Pure: no clock, no provider, no terminal, so the counter and its wording are unit
 * testable on their own.
 */

/** The marker every pulse line starts with, so an agent can recognise one. */
export const PULSE_MARKER = '[pulse]';

/** The reasons a pulse may be reset to 0, the two the backlog names included. */
export const PULSE_RESET_REASONS = Object.freeze(['start', 'manual', 'item-completed', 'compaction']);

/**
 * A usable hard limit: a positive integer, else `fallback`, else the default 30.
 * Invalid input is never `NaN` and never negative — a broken environment variable
 * must not be able to disable or invert the pulse.
 */
export function normalizePulseLimit(value, fallback = PULSE_LIMIT_DEFAULT) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const spare = Number.parseInt(String(fallback ?? ''), 10);
  return Number.isFinite(spare) && spare > 0 ? spare : PULSE_LIMIT_DEFAULT;
}

/**
 * The line carried by the request: plain, one line, and it says what clears the
 * counter — the two resets the backlog names.
 * 
 * REMOVED BECAUSE THIS BREAKS CACHE HIT PERFORMANCE
 */
export function formatPulseText({ count = 0, limit = PULSE_LIMIT } = {}) {
  return "";

  const used = Math.max(0, Math.trunc(Number(count) || 0));
  const cap = normalizePulseLimit(limit);
  const remaining = cap - used;
  if (remaining > 0) {
    return `${PULSE_MARKER} model call ${used} of ${cap} — ${remaining} left.`
      + ' Reset to 0 by completing a task.md item (update_task) or by a compaction.';
  }
  return `${PULSE_MARKER} model call ${used} of ${cap} — hard limit reached.`
    + ' Stop starting new work: complete the current task.md item (update_task action "complete")'
    + ' or compact the context now; either one resets the pulse to 0.';
}

/** The transient notice raised once, the first time a call goes past the cap. */
export function formatPulseLimitNotice({ count = 0, limit = PULSE_LIMIT } = {}) {
  const used = Math.max(0, Math.trunc(Number(count) || 0));
  const cap = normalizePulseLimit(limit);
  return `Model-call pulse passed its hard limit: call ${used} of ${cap}.`
    + ' Complete a task.md item or run a compaction to reset it.';
}

/**
 * The counter itself.
 *
 * `tick()` counts the call that is about to be sent and reports whether this is the
 * first call *beyond* the cap (`crossed`), which is what the host turns into a single
 * notice. `reset(reason)` puts the count back to 0 and records why: a completed
 * `task.md` item and a compaction are the two moments the backlog names, and the
 * next crossing is announced again.
 */
export function createTaskPulse({ limit = PULSE_LIMIT } = {}) {
  const cap = normalizePulseLimit(limit);
  let count = 0;
  let resets = 0;
  let resetReason = 'start';
  let limitAnnounced = false;

  const report = (extra = {}) => ({
    count,
    limit: cap,
    remaining: Math.max(0, cap - count),
    over: count > cap,
    resets,
    resetReason,
    text: formatPulseText({ count, limit: cap }),
    ...extra,
  });

  return {
    /** The hard limit, as configured (default 30). */
    get limit() {
      return cap;
    },
    /** How many calls the current stretch of work has cost. */
    get count() {
      return count;
    },
    /** Count the call this line is about to ride on. */
    tick() {
      count += 1;
      // The first call past the cap is announced exactly once: it is news, and
      // re-announcing it on every later call would drown the notice overlay.
      const crossed = count === cap + 1 && !limitAnnounced;
      if (crossed) limitAnnounced = true;
      return report({ crossed });
    },
    /** Put the counter back to 0, recording why (see PULSE_RESET_REASONS). */
    reset(reason = 'manual') {
      count = 0;
      resets += 1;
      resetReason = String(reason ?? '').trim() || 'manual';
      limitAnnounced = false;
      return report({ reason: resetReason });
    },
    /** The line, without counting anything (a read, not a tick). */
    text() {
      return formatPulseText({ count, limit: cap });
    },
    /** The same line as the `system` message the request carries. */
    message() {
      const line = formatPulseText({ count, limit: cap });
      return line ? { role: 'system', content: line } : null;
    },
    /** A snapshot for the host, the notice and the tests. */
    stats() {
      return report();
    },
  };
}
