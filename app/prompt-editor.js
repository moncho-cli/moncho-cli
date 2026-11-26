import { graphemes, displayWidth, clustersWithin, tailWithin, cutCodePoints } from './cell-width.js';
import { PASTE_TOKEN_RE } from './paste-tags.js';

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
 *
 * A **paste token** (`[pasted 3 lines #0]`, `app/paste-tags.js`) is one unit too: the
 * caret moves over it whole and a backspace/delete removes the whole token, so a pasted
 * block behaves as the single thing it looks like rather than as nineteen characters the
 * user would have to pick apart (`docs/interface/tui`).
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

  /**
   * The paste tokens currently in the text, as cluster-index spans.
   *
   * Recomputed from the text on each use rather than cached: the tokens are a *reading* of
   * the value, and a cache would have to be invalidated by every operation — the kind of
   * bookkeeping that drifts. The box is one line, so the scan is cheap.
   */
  const tokenSpans = () => {
    const text = clusters.join('');
    const spans = [];
    for (const match of text.matchAll(PASTE_TOKEN_RE)) {
      const start = graphemes(text.slice(0, match.index)).length;
      spans.push({ start, end: start + graphemes(match[0]).length, id: Number(match[2]) });
    }
    return spans;
  };

  /** The token whose last cluster sits at `index` (the caret just after it). */
  const spanEndingAt = (index) => tokenSpans().find((span) => span.end === index) || null;

  /** The token whose first cluster sits at `index` (the caret just before it). */
  const spanStartingAt = (index) => tokenSpans().find((span) => span.start === index) || null;

  /** The token the caret is strictly inside (never at either edge). */
  const spanAround = (index) => tokenSpans().find((span) => span.start < index && index < span.end) || null;

  /** Remove a whole token span and park the caret where it began. */
  const cutSpan = (span) => {
    clusters.splice(span.start, span.end - span.start);
    position = span.start;
    return true;
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

    /** Delete the cluster before the caret, or the whole paste token it ends. */
    backspace() {
      if (position === 0) return false;
      const span = spanEndingAt(position) || spanAround(position - 1);
      if (span) return cutSpan(span);
      clusters.splice(position - 1, 1);
      position -= 1;
      return true;
    },

    /** Delete the cluster under the caret, or the whole paste token it starts. */
    deleteForward() {
      if (position >= clusters.length) return false;
      const span = spanStartingAt(position) || spanAround(position);
      if (span) return cutSpan(span);
      clusters.splice(position, 1);
      return true;
    },

    /** One cluster to the left; a paste token is crossed whole. */
    left() {
      if (position === 0) return false;
      const span = spanEndingAt(position) || spanAround(position);
      if (span) {
        position = span.start;
        return true;
      }
      position -= 1;
      return true;
    },

    /** One cluster to the right; a paste token is crossed whole. */
    right() {
      if (position >= clusters.length) return false;
      const span = spanStartingAt(position) || spanAround(position);
      if (span) {
        position = span.end;
        return true;
      }
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

    /** The paste tokens in the text right now, as `{start, end, id}` cluster spans. */
    tokens() {
      return tokenSpans();
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
