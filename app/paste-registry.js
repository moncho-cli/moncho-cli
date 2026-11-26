import {
  collapsePaste,
  expandPastes,
  pasteTokenIds,
  PASTE_THRESHOLD,
} from './paste-tags.js';

/**
 * The TUI's paste table (`docs/interface/paste-input`).
 *
 * A pasted block is shown in the box as a `[pasted N lines #id]` token and its bytes are
 * kept here, so expanding restores them **byte-for-byte** and the model receives exactly
 * what was pasted. The table owns the id → text map, so the screen wiring only has to ask
 * for a collapse and report what happened.
 *
 * Two properties are the whole design:
 *
 *  - **the ids are monotonic, never reused.** The table shrinks when a token is deleted
 *    from the box (`prune()`), so the live entries alone cannot say which ids are free —
 *    `floor` remembers the highest one ever handed out. Reusing a freed id would make a new
 *    paste indistinguishable from the one just removed, and an old token still in the box
 *    would silently point at the new bytes.
 *  - **the shrink is driven by what is really in the box.** `prune()` takes the box's text
 *    and drops every entry whose token no longer appears in it, so removing a token shrinks
 *    the table without any caller having to track deletions.
 */
export function createPasteRegistry({ threshold = PASTE_THRESHOLD } = {}) {
  let entries = [];
  // The highest id ever handed out. Kept apart from `entries` precisely because the table
  // shrinks: a floor read off the live entries would fall back and reuse a freed id.
  let floor = -1;

  return {
    /**
     * Collapse `text` into a token if it is a paste worth one.
     * @returns {{text: string, collapsed: boolean, id: number|null, lines: number}}
     */
    collapse(text) {
      const result = collapsePaste(text, threshold, entries, floor);
      entries = result.entries;
      if (result.collapsed) floor = Math.max(floor, result.id);
      return { text: result.text, collapsed: result.collapsed, id: result.id, lines: result.lines };
    },
    /** Restore every `[pasted N lines #id]` token in `text` to the original bytes. */
    expand(text) {
      return expandPastes(text, entries);
    },
    /** Drop one entry by id (a token removed from the box). */
    forget(id) {
      const wanted = String(id);
      const kept = entries.filter((entry) => String(entry.id) !== wanted);
      const removed = kept.length !== entries.length;
      entries = kept;
      return removed;
    },
    /**
     * Keep only the entries whose token is still present in `text`, and report which ids
     * went. This is how the table follows the box: a deleted token takes its bytes with it.
     *
     * @returns {number[]} the ids that were dropped
     */
    prune(text) {
      const live = new Set(pasteTokenIds(text).map(String));
      const gone = entries.filter((entry) => !live.has(String(entry.id))).map((entry) => entry.id);
      if (gone.length) entries = entries.filter((entry) => live.has(String(entry.id)));
      return gone;
    },
    /** The stored pastes, oldest first (exposed for tests). */
    get all() {
      return entries;
    },
    /** The highest id handed out so far (`-1` before the first paste; for tests). */
    get floor() {
      return floor;
    },
  };
}
