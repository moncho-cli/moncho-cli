import { graphemes, displayWidth, clustersWithin, tailWithin, cutCodePoints } from './cell-width.js';

/**
 * The **text** of the input box and where the caret sits in it.
 *
 * neo-blessed's textarea has no editing model at all: its own key listener appends
 * every printable byte to the *end* of the value and its `_listener` carries an
 * explicit `// TODO: Handle directional keys.` (`lib/widgets/textarea.js`), so the
 * arrow keys do nothing and the caret is always after the last character. This module
 * is the missing half: one value, one caret, and the operations an editing box needs.
 *
 * The unit is the **grapheme cluster** (`app/cell-width.js#graphemes`), never the code
 * unit, so the caret can never land in the middle of an emoji: `left()` past a `😀`
 * moves one cluster, and a `backspace` on a `👍🏽` deletes the whole modifier sequence
 * instead of leaving half of it behind.
 *
 * Pure — a string in, a string and one number out, no widget and no screen — so every
 * key's effect is unit tested without a terminal; `app/prompt-keys.js` is what binds
 * this to the box.
 */

/**
 * @param {object} [options]
 * @param {string} [options.value] the starting text ('' by default)
 * @param {number} [options.caret] the starting caret, in clusters; the default is the
 *   end of the text, which is where an empty box's caret belongs
 */
export function createPromptEditor({ value = '', caret = null } = {}) {
  let clusters = graphemes(value);
  let position = caret === null ? clusters.length : clamp(caret, clusters);

  function clamp(index, list) {
    const n = Math.trunc(Number(index));
    if (!Number.isFinite(n)) return list.length;
    return Math.max(0, Math.min(list.length, n));
  }

  /** Where the caret may go: an index in the current cluster list. */
  const at = (index) => {
    position = clamp(index, clusters);
    return position;
  };

  return {
    /** Replace the whole text; `caret` defaults to the end ('' → 0). */
    setValue(text, nextCaret = null) {
      clusters = graphemes(text);
      position = nextCaret === null ? clusters.length : clamp(nextCaret, clusters);
      return this.value;
    },

    /** Type `text` at the caret and land the caret after it. */
    insert(text) {
      const added = graphemes(text);
      if (added.length === 0) return this.value;
      clusters.splice(position, 0, ...added);
      position += added.length;
      return this.value;
    },

    /** Delete the cluster before the caret. Returns true when something went. */
    backspace() {
      if (position === 0) return false;
      clusters.splice(position - 1, 1);
      position -= 1;
      return true;
    },

    /** Delete the cluster under the caret. Returns true when something went. */
    deleteForward() {
      if (position >= clusters.length) return false;
      clusters.splice(position, 1);
      return true;
    },

    /** One cluster to the left; false at the start of the text. */
    left() {
      if (position === 0) return false;
      position -= 1;
      return true;
    },

    /** One cluster to the right; false at the end of the text. */
    right() {
      if (position >= clusters.length) return false;
      position += 1;
      return true;
    },

    home() {
      const moved = position !== 0;
      position = 0;
      return moved;
    },

    end() {
      const moved = position !== clusters.length;
      position = clusters.length;
      return moved;
    },

    /** Move the caret to a cluster index (clamped), e.g. after a recall. */
    moveTo(index) {
      return at(index);
    },

    /**
     * The text a one-line box of `maxCells` cells shows, with the caret inside it.
     *
     * While the whole text fits, that is the text and the caret's real column. Once it
     * does not, the window **follows the caret**: it keeps the cells ending at the
     * caret — so the characters just typed stay in view — and fills the remaining room
     * to the right. This is the honest version of what neo-blessed's own textbox does
     * with `value.slice(-(width - 2))`, which cuts on code units and ignores the caret
     * entirely.
     *
     * Returns `{ text, caretCells, offset }`: the visible text, the caret's column in
     * cells inside it, and how many clusters were dropped from the left.
     */
    window(maxCells = 40) {
      const cells = Math.max(1, Math.trunc(Number(maxCells)) || 1);
      const all = this.value;
      if (displayWidth(all) <= cells) return { text: all, caretCells: this.caretCells(), offset: 0 };

      const left = clusters.slice(0, position).join('');
      const { text: before, cells: caretCells } = tailWithin(left, cells);
      const offset = position - graphemes(before).length;
      const rest = clusters.slice(offset).join('');
      return { text: clustersWithin(rest, cells).join(''), caretCells, offset };
    },

    /** How many cells `text` occupies before the caret, i.e. the caret's column. */
    caretCells() {
      return displayWidth(clusters.slice(0, position).join(''));
    },

    /** The first `maxChars` clusters of the value, `…` included (see cutCodePoints). */
    preview(maxChars) {
      return cutCodePoints(this.value, maxChars);
    },

    /** The whole text, verbatim: what the model receives is exactly this. */
    get value() {
      return clusters.join('');
    },
    /** The caret, in clusters from the start of the text. */
    get caret() {
      return position;
    },
    /** How many clusters the text holds. */
    get length() {
      return clusters.length;
    },
    /** True when the caret is after the last cluster (where typing appends). */
    get atEnd() {
      return position >= clusters.length;
    },
    /** True when the caret is before the first cluster. */
    get atStart() {
      return position === 0;
    },
    /** The text is empty. */
    get isEmpty() {
      return clusters.length === 0;
    },
  };
}
