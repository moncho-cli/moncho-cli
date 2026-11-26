import {
  claimKeyboard,
  releaseKeyboardLater,
  keyboardHeldBy,
  KEYBOARD_OWNER_PASTE,
  KEYBOARD_OWNER_MODAL,
} from './keyboard-ownership.js';
import { isPasteChunk, stripBracketedPaste } from './paste-tags.js';

/**
 * Catching a paste **before** it becomes keystrokes (`docs/interface/paste-input`).
 *
 * A terminal does not tell a program "the user pasted": with bracketed paste off — which
 * is how most terminals reach this program — a paste arrives as ordinary input, and the
 * only place its bytes are still intact is the raw chunk the input stream hands over.
 * neo-blessed parses that chunk into a burst of `keypress` events a moment later
 * (`node_modules/neo-blessed/lib/program.js#_listenInput`), and by then the damage is
 * done: the widget's own listener appends each byte to the end of the value and
 * `Textbox.setValue()` strips every `\n` (`lib/widgets/textbox.js`), while a `\r` is read
 * as Enter and submits the message on the paste's first line.
 *
 * So this module sits on the **data** event, which is the earliest point that has the
 * paste whole, and does two things for one chunk:
 *
 *  - **swallows the keys it would become.** A keyboard lease
 *    (`app/keyboard-ownership.js`) raises `screen.lockKeys`, which gates blessed's own
 *    dispatch to the focused widget, and is released on the microtask — after the chunk's
 *    keypresses have all been emitted, so the box receives none of them. The lease is a
 *    lease, not a flag: it cannot unlock a modal that is open, and it restores whatever
 *    lock the screen carried.
 *  - **hands the text over as one value**, through the `onPaste` callback, so the caller
 *    can put a token in the box and keep the bytes in its table.
 *
 * Two gates keep it from interfering with anything that is not its business:
 *
 *  - a chunk that is *not* a paste (ordinary typing, a lone Enter, an arrow key) is left
 *    completely alone — no lease, no lock, no callback. That is the property that keeps
 *    this from being a keystroke filter: it is a paste catcher, and everything else travels
 *    the path it always did.
 *  - a chunk that **is** a paste is only taken while the input box is really its
 *    destination (`claim`). When the box is not reading, or a modal owns the keyboard, the
 *    keystrokes have somewhere else to go (a modal's field, or nowhere at all) and
 *    swallowing them into a token would be the interference this module exists to avoid.
 */

/**
 * @param {object} options
 * @param {object} [options.program] the blessed program (its `data` event carries the chunk)
 * @param {object} [options.screen] the screen the keyboard lease is taken on
 * @param {Function} [options.onPaste] `(text) => void`, called with the paste's bytes
 * @param {Function} [options.claim] `() => boolean` — whether the input box would receive
 *   this paste right now (it is reading, and no modal holds the keyboard)
 * @param {number} [options.threshold] minimum content lines to count as a paste
 * @param {boolean} [options.enabled] `false` turns the catcher off entirely
 */
export function createPasteIntake({
  program = null,
  screen = null,
  onPaste = null,
  claim = null,
  threshold = undefined,
  enabled = true,
} = {}) {
  // Without a stream to read or somewhere to put the result, there is nothing to catch:
  // every method stays a harmless no-op, exactly like the other seams without a widget.
  if (!program || typeof program.on !== 'function' || typeof onPaste !== 'function') {
    return { enabled: false, attach: () => false, detach: () => false, close: () => false };
  }

  let attached = false;
  let closed = false;

  /** Whether the box is the destination right now. No claim given means "always". */
  const claimed = () => {
    if (typeof claim !== 'function') return true;
    try {
      return claim() !== false;
    } catch {
      // A broken gate must never cost the user their paste: a claim that throws declines.
      return false;
    }
  };

  /**
   * The one listener. A chunk that is not a paste returns immediately — that early exit
   * is what makes ordinary typing cost nothing but a string scan.
   */
  const onData = (chunk) => {
    if (closed) return;
    const raw = typeof chunk === 'string' ? chunk : String(chunk ?? '');
    if (!isPasteChunk(raw, threshold ?? undefined)) return;
    // Not ours: the box is not reading, or a modal owns the keyboard. The keys then take
    // the path they always did, which is exactly what should happen.
    if (!claimed()) return;

    // The lease is taken **before** blessed parses the chunk (its parser runs on the same
    // event) and released on the microtask, so the whole burst is gated and the box never
    // sees a byte of it.
    if (enabled) {
      const lease = claimKeyboard({ screen, label: KEYBOARD_OWNER_PASTE });
      releaseKeyboardLater(lease);
    }
    // The markers are transport, never content: they are stripped here so no caller has to
    // know bracketed paste exists.
    onPaste(stripBracketedPaste(raw));
  };

  const attach = () => {
    if (closed || attached) return false;
    program.on('data', onData);
    attached = true;
    return true;
  };

  const detach = () => {
    if (!attached) return false;
    program.removeListener('data', onData);
    attached = false;
    return true;
  };

  attach();

  return {
    enabled: true,
    attach,
    detach,
    /** Whether the catcher is listening right now. */
    get attached() {
      return attached;
    },
    /** Whether the box would receive a paste right now (the gate, for tests). */
    get claimed() {
      return claimed();
    },
    close() {
      if (closed) return false;
      detach();
      closed = true;
      return true;
    },
  };
}

/**
 * The gate the input stack passes: a paste belongs to the box only while the box is inside
 * its read cycle **and** no modal has taken the keyboard (a modal's field is the field the
 * user is typing into, so the paste is the modal's).
 */
export function pasteBelongsToBox({ isReading = () => false } = {}) {
  return () => Boolean(isReading()) && !keyboardHeldBy(KEYBOARD_OWNER_MODAL);
}
