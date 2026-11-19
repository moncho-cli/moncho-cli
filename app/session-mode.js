/**
 * The session's intent mode: `Chat` / `Design` / `Work`, held apart from the
 * execution lock (`work:on` / `work:off`).
 *
 * A CLI agent blurs talking about code with mutating code: "how would we refactor
 * this?" must not edit a file, while an approved item on `task.md` must be executed
 * autonomously. The gap is closed with two *separate* notions:
 *
 *  - an **intent mode** — `chat` (read-only), `design` (authors the tracking
 *    files), `work` (executes them);
 *  - an **execution state** — the `work` lock. While it is on the mode is pinned
 *    to `work`: `Tab` and a mode switch are refused, and only `/work off` releases
 *    it (falling back to `design`).
 *
 * The whole machine is pure and terminal-free: `Tab` in the TUI and `/work` in the
 * command registry (`docs/interface/commands`) drive *this* object, so the same rules
 * hold with or without a screen. It paints nothing; it answers the label, the colour
 * and the state key, and `app/session-mode-label.js` turns those into the leftmost
 * cell of the model row.
 *
 * @see docs/interface/modes
 */

/** The three intent modes, in `Tab` order. */
export const MODE_ORDER = Object.freeze(['chat', 'design', 'work']);

/** The modes by name, so a caller never spells a bare string. */
export const MODES = Object.freeze({ CHAT: 'chat', DESIGN: 'design', WORK: 'work' });

/** The label painted for each mode. */
export const MODE_LABELS = Object.freeze({ chat: 'Chat', design: 'Design', work: 'Work' });

/**
 * One bright colour per state. `work:on` gets its own, hotter colour because it is
 * the one state the user may not leave with `Tab` (`docs/interface/modes`).
 */
export const MODE_COLORS = Object.freeze({
  chat: 'green',
  design: 'bright-cyan',
  work: 'yellow',
  'work:on': 'bright-red',
});

/**
 * The mode a fresh session starts in: `work`.
 *
 * The operator works *out of* `work` — a session opens able to execute the backlog,
 * and `Tab` is how a casual question is moved somewhere it cannot touch a file — so
 * the default is the executing mode, not the read-only one.
 *
 * The junk fallback is deliberately **not** this constant: see `normalizeMode()`.
 */
export const DEFAULT_MODE = MODES.WORK;

/** The label of the locked state (mode `work` with the execution lock on). */
export const WORK_ON_LABEL = 'Work:on';

/** The notice `Tab` and a refused mode switch answer with while the lock is on. */
export const WORK_LOCK_NOTICE =
  'Work is on: the mode is locked until /work off.';

/**
 * Anything that is not one of the three known names is `chat`: the safe, read-only
 * fallback for input the session cannot vouch for. It is deliberately **not**
 * `DEFAULT_MODE`: a session that *opens* in `work` and one whose stored mode is junk
 * must never land in the same place.
 */
export function normalizeMode(value) {
  const name = String(value ?? '').trim().toLowerCase();
  return MODE_ORDER.includes(name) ? name : MODES.CHAT;
}

/** The mode `Tab` moves to from `mode`, wrapping `work` back to `chat`. */
export function nextMode(mode) {
  const index = MODE_ORDER.indexOf(normalizeMode(mode));
  return MODE_ORDER[(index + 1) % MODE_ORDER.length];
}

/**
 * The mode `Shift+Tab` moves to from `mode`, wrapping `chat` back to `work`.
 *
 * It is the exact inverse of `nextMode()`, so the ring can be walked in both
 * directions without a second order to keep in step.
 */
export function prevMode(mode) {
  const index = MODE_ORDER.indexOf(normalizeMode(mode));
  return MODE_ORDER[(index - 1 + MODE_ORDER.length) % MODE_ORDER.length];
}

/**
 * The state key of a session: the mode, or `work:on` while the execution lock is
 * engaged. It is what names the colour and the label, so a caller never has to
 * combine the two by hand.
 */
export function modeStateKey(mode, work = false) {
  const name = normalizeMode(mode);
  return name === MODES.WORK && work ? 'work:on' : name;
}

/** The label of a state: `Chat`, `Design`, `Work`, or `Work:on` while locked. */
export function formatModeLabel(mode, work = false) {
  const key = modeStateKey(mode, work);
  return key === 'work:on' ? WORK_ON_LABEL : MODE_LABELS[key];
}

/** The bright colour of a state (`MODE_COLORS`). */
export function modeColor(mode, work = false) {
  return MODE_COLORS[modeStateKey(mode, work)];
}

/**
 * Create one session's mode.
 *
 * The object is the single source of truth for the three rules the contract names:
 * `Tab` walks `Chat -> Design -> Work`, every mode change is refused while the lock
 * is on, `/work on` pins the mode to `Work`, and `/work off` releases it and falls
 * back to `Design`. Subscribers are notified on every accepted change, so the TUI
 * repaints the label exactly when the state moves and never on a refused move.
 *
 * A session with no stored state opens in `DEFAULT_MODE` (`work`), and the lock is
 * off unless the caller restores one.
 *
 * @param {{mode?: string, work?: boolean}} [initial] the mode and the lock to start from
 */
export function createSessionMode({ mode = DEFAULT_MODE, work = false } = {}) {
  let current = work ? MODES.WORK : normalizeMode(mode);
  let locked = Boolean(work);
  const listeners = new Set();

  const notify = () => {
    const snapshot = describe();
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        // A broken repaint must never cost the user their mode change.
      }
    }
  };

  function describe() {
    return {
      mode: current,
      work: locked,
      key: modeStateKey(current, locked),
      label: formatModeLabel(current, locked),
      color: modeColor(current, locked),
    };
  }

  /** Apply one accepted move and tell the subscribers. */
  function apply(next, nextWork) {
    current = normalizeMode(next);
    locked = Boolean(nextWork);
    notify();
    return describe();
  }

  /** Refuse a move that the lock forbids, with the notice that explains it. */
  function refused(reason) {
    return { changed: false, reason, notice: WORK_LOCK_NOTICE, ...describe() };
  }

  return {
    /** The current mode. */
    get mode() {
      return current;
    },
    /** True while the execution lock (`work:on`) is engaged. */
    get work() {
      return locked;
    },
    /** The label, the colour and the key of the current state. */
    describe,

    /**
     * Move to `target` — refused while the lock is on, and a no-op when the mode
     * already is the target. Returns the outcome, never throws.
     */
    setMode(target) {
      const next = normalizeMode(target);
      if (locked) return refused('work-on');
      if (next === current) return { changed: false, reason: 'same-mode', ...describe() };
      return { changed: true, ...apply(next, false) };
    },

    /**
     * `Tab`: `Chat -> Design -> Work`, refused while the lock is on.
     *
     * `direction` of `-1` is `Shift+Tab`, which walks the same ring backwards
     * (`Chat -> Work -> Design`). Any other value is the forward move.
     */
    cycle({ direction = 1 } = {}) {
      if (locked) return refused('work-on');
      const step = Number(direction) < 0 ? prevMode : nextMode;
      return { changed: true, ...apply(step(current), false) };
    },

    /**
     * `/work on` pins the mode to `Work` and engages the lock; `/work off` releases
     * it and falls back to `Design` (the mode that authors work, never to `Chat`,
     * so the task.md the user was writing stays writable).
     */
    setWork(on) {
      const wanted = Boolean(on);
      if (wanted === locked) {
        return { changed: false, reason: wanted ? 'already-on' : 'already-off', ...describe() };
      }
      return { changed: true, ...apply(wanted ? MODES.WORK : MODES.DESIGN, wanted) };
    },

    /** The current state as a plain, storable object (the session file). */
    toJSON() {
      return { mode: current, work: locked };
    },

    /**
     * Adopt the state stored with a resumed conversation.
     *
     * This is deliberately **not** a mode change: `/sessions` restores what the
     * conversation *was*, and `setMode()` is refused while the lock is on — a resumed
     * `work:on` session would otherwise open in the wrong state. A `null` payload
     * changes nothing, so an old file that stores no mode leaves the session in the
     * state it already had (`docs/interface/modes`).
     */
    restore(state) {
      if (!state) return describe();
      if (state.work) return apply(MODES.WORK, true);
      return apply(normalizeMode(state.mode), false);
    },

    /** Subscribe to every accepted change; the returned function unsubscribes. */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}