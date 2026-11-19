/**
 * How long the session has been *working* (task-backlog: "add working time counter
 * to sessions … so only add up time the model spent thinking or a tool call
 * resolving … dont send any of this to the model, is user facing information only").
 *
 * Three counters already exist and each answers a different question: the status
 * meter says how full the window is, the per-model table says what each model
 * consumed, and the call pulse says how many calls a stretch of work took. None of
 * them says how much wall clock the agent actually spent. This module owns that
 * fourth counter, and it owns it as a **rule**: only a span the model spent
 * thinking and a span a tool call spent resolving is added up — the time a reader
 * spends reading, or the process spends idle between turns, is not work.
 *
 * Two halves, both terminal-free:
 *
 *  - `formatDuration()` / `formatWorkRow()` turn milliseconds into the one row
 *    (`app/work-row.js` paints it, right-aligned, above the status bar);
 *  - `createWorkingClock()` is the span bookkeeping: `begin(kind)` opens a span,
 *    `end(span)` closes it and answers how long it took, and the clock emits once a
 *    second while a span is open so the row can show the number climb instead of
 *    jumping when the call lands.
 *
 * The clock is **host state**. It is never a chunk, never sent to the provider and
 * never stored on its own: the *committed* time is accounted per model in
 * `utils/usage-stats.js` (which is what the session file keeps), and the live total
 * a row paints is that stored time plus whatever span is open right now.
 */

/** The two kinds of work the counter adds up. */
export const WORK_KINDS = Object.freeze(['thinking', 'tool']);

/** How often a row is refreshed while a span is open. */
export const WORK_TICK_MS = 1000;

/**
 * The shortest honest spelling of a duration: `45s`, `3m 12s`, `1h 02m`.
 *
 * Seconds are dropped past the first hour (nobody reads `1h 02m 07s` on a status
 * row) and zero-padded inside a larger unit, so the row keeps one width as it
 * climbs. Junk and negatives read as `0s` rather than `NaNs`.
 */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * The row's text: `working 3m 12s`, and the empty string while nothing was worked.
 *
 * One number on purpose. The thinking/tool split is per model and belongs to
 * `/usage` (utils/usage-stats.js#formatUsageRow), where there is room to spell it
 * out; a right-aligned single row is not the place for it.
 */
export function formatWorkRow(totals = {}) {
  const thinking = Number(totals?.thinkingMs) || 0;
  const tool = Number(totals?.toolMs) || 0;
  const total = Number.isFinite(Number(totals?.totalMs)) ? Number(totals.totalMs) : thinking + tool;
  return total > 0 ? `working ${formatDuration(total)}` : '';
}

/**
 * The span clock.
 *
 * `begin(kind)` opens a span and arms the one-second tick; `end(span)` closes it,
 * disarms the tick once nothing is open and returns the elapsed time. Overlapping
 * spans (a batch of tool calls runs together) are each measured once, and
 * `openTotals()` adds the *in-flight* part of every open span, so the number a row
 * paints is current instead of one tick stale.
 *
 * Injected `now`/`arm`/`disarm` keep the whole thing testable without a clock or a
 * timer; every listener is called inside a `try`, because a broken row must never
 * cost the user their turn.
 */
export function createWorkingClock({
  now = () => Date.now(),
  tickMs = WORK_TICK_MS,
  arm = setInterval,
  disarm = clearInterval,
} = {}) {
  const open = [];
  const listeners = new Set();
  let timer = null;

  const openMs = (kind) => open
    .filter((span) => span.kind === kind)
    .reduce((sum, span) => sum + Math.max(0, now() - span.at), 0);

  const openTotals = () => {
    const thinkingMs = openMs('thinking');
    const toolMs = openMs('tool');
    return { thinkingMs, toolMs, totalMs: thinkingMs + toolMs };
  };

  const stopTimer = () => {
    if (timer === null) return;
    disarm(timer);
    timer = null;
  };

  const emit = () => {
    const snapshot = openTotals();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // display only: a broken row must not break the turn
      }
    }
    return snapshot;
  };

  return {
    /** Open a span of `kind`; the returned handle is what `end()` closes. */
    begin(kind = 'thinking') {
      const span = { kind: WORK_KINDS.includes(kind) ? kind : 'thinking', at: now() };
      open.push(span);
      if (timer === null) {
        timer = arm(() => emit(), tickMs);
        if (typeof timer?.unref === 'function') timer.unref();
      }
      emit();
      return span;
    },
    /** Close a span and answer its duration; an unknown handle is a 0 no-op. */
    end(span) {
      if (!span) return 0;
      const index = open.indexOf(span);
      if (index < 0) return 0;
      open.splice(index, 1);
      const ms = Math.max(0, now() - span.at);
      if (open.length === 0) stopTimer();
      emit();
      return ms;
    },
    /** The in-flight part of every open span. */
    openTotals,
    isWorking: () => open.length > 0,
    /** Repaint without a span moving (a caller whose stored totals just changed). */
    touch: () => emit(),
    /** Follow every change, tick included; the returned function unsubscribes. */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Release the timer and the listeners (screen teardown, process exit). */
    close() {
      stopTimer();
      listeners.clear();
    },
  };
}
