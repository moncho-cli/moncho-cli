/**
 * Coalescing a repaint that a burst of events would otherwise fire once each.
 *
 * The drag that paints the selection band reaches us as a **stream** of reports, not one per
 * frame: blessed decodes a chunk of input and emits every report it contained in the same
 * synchronous turn (`program.js#_bindMouse` -> `screen.js#_listenMouse`), and a fast drag
 * spans many reports per chunk. Repainting for each of them costs the reader the *sum* of
 * those paints — and because one paint re-renders the whole conversation, a long transcript
 * turns a flick of the wrist into a backlog the band never catches up with. The report is
 * exactly that: "when the conversation is very long, it really lags … like a second to catch
 * up with the position of the cursor", while a new conversation is fast.
 *
 * The fix is not to paint less *often* by a clock — an arbitrary interval would make the band
 * lag by design — but to paint once per **turn**: every request made before the scheduler
 * fires collapses into the single paint at the end of it, which is the same paint the last
 * request would have produced. The band therefore arrives at the pointer's final position in
 * the turn the reader moved in, and the frames in between are not lost work but work never
 * done.
 *
 * Three operations, and the two edges are why they are separate:
 *
 *  - `request()` — paint at the end of this turn, unless a paint is already pending;
 *  - `flush()` — paint **now** and drop any pending one, for an edge that must be seen at
 *    that instant (the release: the band has to leave the screen before anything else);
 *  - `cancel()` — drop a pending paint without painting, for a teardown.
 *
 * `schedule`/`cancelSchedule` are injected so a test drives the whole thing with no timers
 * and no screen, and so the caller can hand in its own tick (`setImmediate` is the default
 * because that is the turn boundary Node already has).
 */
export function createPaintCoalescer({
  paint = () => {},
  schedule = (fn) => setImmediate(fn),
  cancelSchedule = (handle) => clearImmediate(handle),
} = {}) {
  /** The scheduled paint, or null when none is pending. */
  let pending = null;

  const run = () => {
    pending = null;
    paint();
  };

  return {
    /**
     * Ask for a paint at the end of this turn. Idempotent within the turn: the second and
     * later requests of a burst join the first rather than queueing another paint.
     */
    request() {
      if (pending !== null) return false;
      pending = schedule(run);
      return true;
    },
    /** Paint now, dropping a pending one so the turn's end does not paint twice. */
    flush() {
      if (pending !== null) {
        cancelSchedule(pending);
        pending = null;
      }
      paint();
      return true;
    },
    /** Drop a pending paint without painting (close, a lost screen). */
    cancel() {
      if (pending === null) return false;
      cancelSchedule(pending);
      pending = null;
      return true;
    },
    /** True while a paint is scheduled and not yet run. */
    get pending() {
      return pending !== null;
    },
  };
}
