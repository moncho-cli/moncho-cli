/**
 * Writing `context.json` **as** the conversation happens, not at the end of a turn.
 *
 * The session loop saves once a turn lands (`saveSession('turn')`), which is the wrong
 * granularity for a record whose whole purpose is to survive a process that dies: a turn
 * is a provider call, a tool batch and another provider call, so it holds minutes of work
 * the file knows nothing about until it ends. The recorder is deliberately dumb about
 * *when* to save (`app/session-recorder.js`), so the rule lives here.
 *
 * The rule is a **leading-edge throttle**, and both halves matter:
 *
 *  - **the first change is written immediately.** The window is empty until the user's
 *    message lands; once it does, the conversation is on disk — that is what "saved as
 *    soon as messages hit the conversation" means;
 *  - **a burst is coalesced into one write.** One tool batch adds an assistant chunk plus
 *    one chunk per call in the same tick, and a record is hundreds of kilobytes written
 *    under byte-for-byte verification (`utils/file-io.js`), so a write per chunk would
 *    cost a session far more than it buys. A change inside the interval arms one trailing
 *    write instead, and the last change wins.
 *
 * Two more operations exist because the loop needs them: `settle()` drops anything
 * pending because a save already superseded it (the turn and exit saves), and `close()`
 * stops the throttle for good. A save that throws is contained and reported through
 * `lastError` — the record is important, the conversation more so.
 *
 * Terminal-free and clock-free: the timer and the clock are injected, so every rule below
 * is provable without sleeping in a test.
 */

/** Shortest gap between two coalesced writes of the same record. */
export const AUTOSAVE_INTERVAL_MS = 500;

/**
 * @param {object} options
 * @param {(reason: string) => any} [options.save] writes the record; called with the reason
 * @param {number} [options.intervalMs] the throttle window, in milliseconds
 * @param {() => number} [options.now] the clock, in milliseconds
 * @param {Function} [options.arm] schedules one write: `(fn, ms) => handle`
 * @param {Function} [options.disarm] cancels a scheduled write: `(handle) => void`
 */
export function createSessionAutosave({
  save = () => null,
  intervalMs = AUTOSAVE_INTERVAL_MS,
  now = () => Date.now(),
  arm = null,
  disarm = null,
} = {}) {
  const write = typeof save === 'function' ? save : () => null;
  const interval = Number.isFinite(intervalMs) && intervalMs >= 0 ? intervalMs : AUTOSAVE_INTERVAL_MS;
  const clock = typeof now === 'function' ? now : () => Date.now();
  // A pending write must never hold the process open on its own: the host owns the exit.
  const schedule = typeof arm === 'function'
    ? arm
    : (fn, ms) => {
      const handle = setTimeout(fn, ms);
      if (typeof handle.unref === 'function') handle.unref();
      return handle;
    };
  const unschedule = typeof disarm === 'function' ? disarm : (handle) => clearTimeout(handle);

  let timer = null;
  let pending = null;
  let lastAt = null;
  let writes = 0;
  let lastRecord = null;
  let lastError = null;
  let closed = false;

  const stopTimer = () => {
    if (timer === null) return;
    unschedule(timer);
    timer = null;
  };

  /** Write now, whatever was queued, and answer the record the save produced. */
  const writeNow = (reason) => {
    stopTimer();
    pending = null;
    lastAt = clock();
    writes += 1;
    try {
      const record = write(reason);
      if (record !== undefined && record !== null) lastRecord = record;
      lastError = null;
    } catch (error) {
      // A failed write is reported, never thrown: the conversation goes on.
      lastError = error;
    }
    return lastRecord;
  };

  return {
    /**
     * Mark the conversation as changed, and write it when that is due.
     *
     * @param {string} [reason] what changed (`user`, `reply`, `tools`, `compact`, …)
     * @returns {boolean} true when this call wrote the record
     */
    touch(reason = 'chunk') {
      if (closed) return false;
      pending = reason;
      // Already scheduled: this change joins the write that is on its way.
      if (timer !== null) return false;
      const elapsed = lastAt === null ? Infinity : clock() - lastAt;
      if (elapsed >= interval) {
        writeNow(reason);
        return true;
      }
      timer = schedule(() => {
        timer = null;
        const why = pending;
        if (why !== null) writeNow(why);
      }, interval - elapsed);
      return false;
    },
    /**
     * Drop whatever is pending, because a save already superseded it.
     *
     * The loop saves after a turn and on exit; those writes hold every chunk of the
     * window, so the queued one would write the same bytes again.
     *
     * The throttle window restarts from that save, so the next change is written
     * immediately instead of being coalesced into a write that already happened.
     *
     * @returns {number} how many writes were made so far
     */
    settle() {
      stopTimer();
      pending = null;
      lastAt = clock();
      return writes;
    },
    /** Stop for good: the session is over and nothing is left to autosave. */
    close() {
      closed = true;
      stopTimer();
      pending = null;
      return writes;
    },
    get writes() {
      return writes;
    },
    /** The reason waiting for the trailing write, or null when nothing is queued. */
    get pending() {
      return pending;
    },
    /** True while on the leading edge of the throttle — the immediate write is on. */
    get armed() {
      return lastAt !== null && timer === null;
    },
    get lastRecord() {
      return lastRecord;
    },
    get lastError() {
      return lastError;
    },
    get isClosed() {
      return closed;
    },
  };
}