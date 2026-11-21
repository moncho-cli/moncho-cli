import { createClipboardFile } from './clipboard-file.js';
import { savedToastText } from './toast.js';

/**
 * The callbacks a transcript pane needs to make a mouse selection *work*: where the copy
 * goes, and what the reader is told about it.
 *
 * Extracted from `app/tui.js`, which wires the screen and was at its line budget: the
 * conversation's own selection (`docs/interface/clipboard-selection`) is a complete
 * feature with two ends — the text is saved on one side and a sentence on the other — and
 * neither belongs in the region wiring.
 *
 * **The copy is a file, not a clipboard.** Two ways of reaching the system clipboard were
 * built and both are a hope: a native tool (`pbcopy`, `xclip`, `wl-copy`) is a client of a
 * display server, and a container has none; the OSC 52 escape sequence leaves the container
 * as ordinary output and the *host* terminal decides whether to honour it. A file needs
 * neither — it is written where the user already is, and picking it up is a command they
 * already know (`app/clipboard-file.js`).
 *
 * Three choices are deliberate:
 *
 *  - **the file lands in the workspace**, so it appears at `/app` in the container and in
 *    the checkout's root on the host: the same place from the reader's side either way.
 *  - **the confirmation is the top-right toast, not the notice overlay and not the
 *    conversation.** The overlay reports provider news (a retry, a failure) and holds it
 *    for minutes; a copy is a thing the reader just did on purpose, and needs a flicker of
 *    proof in a corner instead. The conversation never learns of it at all: a copy is
 *    presentation only — never a context chunk, never a session file, nothing to the model.
 *  - **a copy that FAILED speaks up**, while a copy that worked names the file. Silence on
 *    failure would leave the reader believing their text was saved.
 *
 * `toast` may be a **function**, because the TUI builds the toast box after the pane (the
 * pane is created before the brand line the toast anchors to), so reading it eagerly would
 * reach a binding that does not exist yet. A function is resolved on every notice, which is
 * also the right lifetime.
 */
export function createSelectionClipboard({
  dir = process.cwd(), now = () => new Date(), writer = undefined, toast = null,
} = {}) {
  /** The toast sink as it is *now*, or null when there is none. */
  const sink = () => {
    const bar = typeof toast === 'function' ? toast() : toast;
    return typeof bar?.show === 'function' ? bar : null;
  };

  // The writer is built once and kept: the directory it writes into is fixed for the
  // session, so re-reading it per copy would be a decision that never changes.
  const file = writer ?? createClipboardFile({ dir, now });

  return {
    dir: file.dir,
    /**
     * Save `text` to a clipboard file and return the report:
     * `{ ok, file, path, bytes, error }`.
     */
    copy(text) {
      return file.write(text);
    },
    /**
     * One short sentence about what happened, or silence.
     *
     * An empty selection is silence rather than a complaint — the reader selected nothing,
     * which is not a failure. A successful copy names the file, because the name is the
     * reader's next move.
     */
    notify(report) {
      const bar = sink();
      if (!bar) return null;
      if (report?.ok) return bar.show(savedToastText(report.file));
      if (report?.error === 'EMPTY') return null;
      return bar.show(`Could not save the selection: ${report?.error ?? 'unknown error'}`);
    },
  };
}
