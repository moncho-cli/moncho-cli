import { collapsePaste, expandPastes, PASTE_THRESHOLD } from './tui-render.js';

/**
 * The TUI's paste bookkeeping.
 *
 * A long paste is replaced in the input box by a `[[paste:<id>]]` tag and the
 * original bytes are kept here, so expanding restores them **byte-for-byte**
 * (see `docs/interface/tui`). The registry owns the id → text table, so the
 * screen wiring in `app/tui.js` only has to ask for a collapse and report
 * whether anything was collapsed.
 */
export function createPasteRegistry({ threshold = PASTE_THRESHOLD } = {}) {
  let pastes = [];

  return {
    /**
     * Collapse `text` if it is long enough to be worth a tag.
     * @returns {{text: string, collapsed: boolean}} the text to type into the box
     */
    collapse(text) {
      const result = collapsePaste(text, threshold, pastes);
      const collapsed = result.pastes.length !== pastes.length;
      pastes = result.pastes;
      return { text: result.text, collapsed };
    },
    /** Restore every `[[paste:<id>]]` tag in `text` to the original bytes. */
    expand(text) {
      return expandPastes(text, pastes);
    },
    /** The stored pastes, oldest first (exposed for tests). */
    get all() {
      return pastes;
    },
  };
}
