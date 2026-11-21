import { createClipboard } from './clipboard.js';
import { createNativeClipboard } from './clipboard-native.js';
import { COPIED_TOAST_TEXT } from './toast.js';

/**
 * The callbacks a transcript pane needs to make a mouse selection *work*: where the copy
 * goes, and what the reader is told about it.
 *
 * Extracted from `app/tui.js`, which wires the screen and was at its line budget: the
 * conversation's own selection (`docs/interface/clipboard-selection`) is a complete
 * feature with two ends — the text on the clipboard on one side and a sentence on the
 * other — and neither belongs in the region wiring.
 *
 * Four choices are deliberate:
 *
 *  - **the native clipboard tool goes first, OSC 52 second.** A tool that exits 0 has really
 *    put the text where the user will paste it; OSC 52 is the terminal's own clipboard and
 *    is honoured only when the terminal chooses to — xterm gates it behind its
 *    window-operations resource, tmux needs `set-clipboard on`, and a terminal that does not
 *    implement it drops the sequence in silence, which looks exactly like a copy that never
 *    happened (`app/clipboard-native.js`). The sequence is still built, because it is the
 *    only path that reaches a machine with no clipboard tool at all.
 *  - **the confirmation is the top-right toast, not the notice overlay and not the
 *    conversation.** The overlay reports provider news (a retry, a failure) and holds it
 *    for minutes; a copy is a thing the reader just did on purpose, and needs a flicker of
 *    proof in a corner instead. The conversation never learns of it at all: a copy is
 *    presentation only — never a context chunk, never a session file, nothing to the model.
 *  - **a copy that FAILED speaks up**, while a copy that worked says the plain sentence.
 *    Silence on failure would leave the reader believing their text was captured.
 *  - **the writer is the blessed program** when the sequence is the path taken, so it leaves
 *    on the very stream the screen is painted on. Nothing else in the process has a claim on
 *    that stream, and a second writer could interleave a copy with a frame.
 *
 * Both callbacks are defensive — a copy is a convenience, and losing the clipboard must
 * never take the conversation down with it (`app/clipboard.js#createClipboard`).
 *
 * `toast` may be a **function**, and the TUI passes one: the toast box is built after the
 * pane (the pane is created before the brand line the toast anchors to), so reading it
 * eagerly would reach a binding that does not exist yet. A function is resolved on every
 * notice, which is also the right lifetime.
 */
export function createSelectionClipboard({
  screen = null, toast = null, env = process.env, native = undefined,
} = {}) {
  /** The toast sink as it is *now*, or null when there is none. */
  const sink = () => {
    const bar = typeof toast === 'function' ? toast() : toast;
    return typeof bar?.show === 'function' ? bar : null;
  };

  const clipboard = createClipboard({
    write: typeof screen?.program?.write === 'function'
      ? (sequence) => screen.program.write(sequence)
      : null,
    env,
    // Built once and kept: a tool that is not installed is remembered as missing by the
    // writer itself, so trying pbcopy on a Linux box costs one failed spawn per session.
    native: native === undefined ? createNativeClipboard({ env }) : native,
  });

  return {
    clipboard,
    /** The pane's `copy`: returns the report, and never throws. */
    copy: (text) => clipboard.copy(text),
    /**
     * The pane's `notify`: one short sentence about what happened, or silence.
     *
     * An empty selection is silence rather than a complaint — the reader selected nothing,
     * which is not a failure. A truncated copy still says the plain sentence: the text is
     * on the clipboard, it is simply shorter than the drag, and a toast is the wrong place
     * to explain that.
     */
    notify: (report) => {
      const bar = sink();
      if (!report || !bar) return null;
      if (report.ok) return bar.show(COPIED_TOAST_TEXT);
      if (report.error === 'EMPTY') return null;
      return bar.show(`Could not copy: ${report.error}`);
    },
  };
}