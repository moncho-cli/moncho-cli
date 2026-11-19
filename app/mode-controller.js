/**
 * The host half of the `Tab` binding: it drives the session mode and routes a
 * refusal where the user can see it.
 *
 * `app/tui-keys.js` decides *that* a tab was pressed and which way it walks, but it
 * holds no state and paints nothing — it reports the direction to an `onCycleMode`
 * hook. This module is that hook's body: it calls `app/session-mode.js#createSessionMode`
 * and, when the `work:on` lock refuses the move, hands the machine's own
 * `WORK_LOCK_NOTICE` to a `notify(kind, text)` sink.
 *
 * The refusal is **news, not history**: it goes to the transient notice bar in the TUI
 * and to a plain line in the line CLI, exactly like a recovered provider failure
 * (`docs/interface/notice-overlay`). It is never written to the transcript, so a user
 * who presses `Tab` against a locked session does not leave a stale error line in the
 * record of their conversation.
 *
 * Pure and terminal-free: the mode and the sink are injected, so the routing rule is
 * unit tested without a screen, and the same object drives both front ends.
 *
 * @see docs/interface/modes
 */

/** The kind a refusal is shown as: the session is not broken, something was declined. */
export const MODE_REFUSAL_KIND = 'warn';

/**
 * Wrap a session mode so a refused `Tab` explains itself.
 *
 * `cycle({ direction })` returns the machine's own outcome (`{changed, reason, notice,
 * mode, work, key, label, color}`) untouched, so a caller can still tell an accepted
 * move from a refused one. The notice is emitted **only** on a refusal that carries
 * one, so an accepted move stays silent and a no-op move stays silent too.
 *
 * Both dependencies are optional on purpose: with no mode, or no sink, `cycle()` is a
 * harmless no-op rather than a crash — the binding must never cost the user their
 * keystroke, and neither must a notice bar that throws.
 *
 * @param {{mode?: object, notify?: function, kind?: string}} [options]
 */
export function createModeController({ mode = null, notify = null, kind = MODE_REFUSAL_KIND } = {}) {
  const cycle = ({ direction = 1 } = {}) => {
    if (!mode || typeof mode.cycle !== 'function') return null;
    const outcome = mode.cycle({ direction });
    if (!outcome || outcome.changed) return outcome;
    if (outcome.notice && typeof notify === 'function') {
      try {
        notify(kind, outcome.notice);
      } catch {
        // Display only: a broken notice bar must never cost the user their keystroke.
      }
    }
    return outcome;
  };

  return {
    /** Walk the ring one step; a refused move is announced, never thrown. */
    cycle,
    /** The hook `app/tui.js` forwards every `Tab` / `Shift+Tab` to. */
    onCycleMode: (options) => cycle(options),
    /** The state the session is in right now, or null without a mode. */
    describe: () => (mode && typeof mode.describe === 'function' ? mode.describe() : null),
  };
}
