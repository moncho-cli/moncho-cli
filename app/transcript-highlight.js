import { graphemes, graphemeWidth } from './cell-width.js';
import { bandWidthOf } from './prose-band.js';
import { isBefore, normalizePoint } from './transcript-select.js';

/**
 * Painting the live mouse selection: the reverse-video band that shows the reader what
 * a drag has picked up, before it is copied (`docs/interface/clipboard-selection`).
 *
 * The selection itself is model work (`app/transcript-select.js`); this module is the
 * other half — turning a range of *wrapped rows and cells* into the tagged lines the
 * transcript paints. Two things make it fiddly, and both are why it lives on its own:
 *
 *  - **the composed lines are not the wrapped rows.** The view hands blessed one string
 *    per *display line*; blessed breaks a long one into as many rows as it needs. The
 *    selection is expressed in those rows (that is what the mouse names), so a range has
 *    to be mapped back through blessed's own real→fake table (`_clines.ftor`) before a
 *    line can be marked. Re-deriving the wrap instead would put the highlight a few
 *    columns off on exactly the long lines a reader drags across.
 *  - **the lines carry tags.** A banded row is wrapped in a background tag and its text
 *    holds the markdown colours, so the mark cannot be spliced by string index — it has
 *    to be inserted at a *cell* boundary, walking the tags without counting them.
 *
 * Pure: every function takes the lines, the range and the geometry, and returns strings.
 * Nothing here knows about blessed, a screen, or the clipboard.
 */

/**
 * The width blessed really wrapped at, which is the step between a display line's
 * wrapped rows.
 *
 * Deliberately **not** `_clines.width`: blessed stores the width it was handed and then
 * subtracts the scrollbar's own column *inside* `_wrapContent`, so on a region with a
 * scrollbar the stored number is one cell wider than the one the rows were cut to
 * (measured: `_clines.width` 76 against 75-cell rows). `bandWidthOf()` is the width the
 * prose band is padded to, which is the same cell count, so the two agree by
 * construction rather than by coincidence.
 */
export function wrapWidthOf(widget) {
  return bandWidthOf(widget);
}

/** The mark that shows a selection: reverse video, which every terminal has. */
export const SELECTION_TAG_OPEN = '{inverse}';
export const SELECTION_TAG_CLOSE = '{/inverse}';

/**
 * A blessed tag, or one of the two escaped literals, as a unit that costs **no** cells.
 *
 * `{open}` and `{close}` are not tags: they are how the renderer protects a real `{`
 * and `}` in model output (`app/tui-render.js#escapeTags`), so they cost one cell each
 * and are painted as the brace itself. They are told apart from a tag here because
 * counting them as zero would put every mark after a brace a column to the left.
 */
const TAG_RE = /\{open\}|\{close\}|\{[^}]*\}/y;
const ESCAPED_BRACE_RE = /^\{open\}$/;
/**
 * The same tag pattern, non-sticky, for finding where the next tag *starts*.
 *
 * `TAG_RE` is sticky because the walk asks "is there a tag right here?". Locating the
 * end of a text run is the other question — "where is the next tag?" — and a sticky
 * regex cannot answer it, so this copy scans ahead instead.
 */
const TAG_SCAN_RE = /\{open\}|\{close\}|\{[^}]*\}/g;
/**
 * Insert the selection mark into one tagged line at the cell boundaries `[from, to)`.
 *
 * The walk is over **grapheme clusters**, so the mark lands on a character edge and
 * never inside an emoji, and every tag met on the way is emitted untouched — which is
 * what keeps a row's own colours (a cyan `You:`, a bold heading) readable *under* the
 * mark instead of being replaced by it.
 *
 * A cluster is marked when any of its cells falls inside the range, so a wide glyph is
 * marked whole. An open end (`to` not finite) runs to the end of the line, and a mark
 * left open at the end of the line is closed before returning, so a row can never leak
 * reverse video into the rows below it.
 */
export function highlightCells(line, from = 0, to = Infinity) {
  const text = String(line ?? '');
  const start = Math.max(0, Math.trunc(Number(from)) || 0);
  const end = Number.isFinite(to) ? Math.trunc(to) : Infinity;
  if (end <= start) return text;

  let out = '';
  let cell = 0;
  let open = false;
  let index = 0;

  /** Emit one unit of `width` cells, opening or closing the mark as the range asks. */
  const emit = (unit, width) => {
    const unitStart = cell;
    cell += width;
    const inside = unitStart < end && cell > start;
    if (inside && !open) {
      out += SELECTION_TAG_OPEN;
      open = true;
    } else if (!inside && open) {
      out += SELECTION_TAG_CLOSE;
      open = false;
    }
    out += unit;
  };

  // The walk is a sequence of tags and **text runs**, and a run is segmented in ONE
  // pass. An earlier version asked the segmenter for the first cluster of the remainder
  // at every character — `graphemes(text.slice(index))[0]` — which re-segments the rest
  // of the line each time and is quadratic in its length. That cost more than everything
  // else in a drag's paint put together (measured: 55.6ms against 1.55ms for 40 lines),
  // and it is why a long conversation's band lagged the pointer.
  while (index < text.length) {
    TAG_RE.lastIndex = index;
    const tag = TAG_RE.exec(text);
    if (tag) {
      // An escaped literal is one cell of text; a real tag costs nothing.
      if (ESCAPED_BRACE_RE.test(tag[0])) emit(tag[0], 1);
      else out += tag[0];
      index = TAG_RE.lastIndex;
      continue;
    }

    // No tag here: this text run ends at the next tag, or at the end of the line.
    TAG_SCAN_RE.lastIndex = index;
    const next = TAG_SCAN_RE.exec(text);
    const runEnd = next ? next.index : text.length;
    const run = text.slice(index, runEnd);
    for (const cluster of graphemes(run)) emit(cluster, graphemeWidth(cluster));
    index = runEnd;
  }

  return open ? `${out}${SELECTION_TAG_CLOSE}` : out;
}

/**
 * The wrapped-row range of a selection, normalised to reading order and clipped to the
 * rows that exist. Null when there is nothing to paint.
 */
export function selectionRange(anchor, focus, rowCount = Infinity) {
  const a = normalizePoint(anchor);
  const b = normalizePoint(focus);
  if (!a || !b) return null;
  const first = isBefore(a, b) ? a : b;
  const last = first === a ? b : a;
  if (first.row >= rowCount || first.row > last.row) return null;
  if (first.row === last.row && first.cell === last.cell) return null;
  return { first, last };
}

/**
 * The cell range of the selection that falls on one display line, or null.
 *
 * `rows` is the line's own wrapped rows, in order, and `width` the width blessed wrapped
 * at: the offset of a wrapped row inside its display line is therefore `index * width`.
 * A range that does not reach this line answers null, so the common case costs one
 * comparison per line.
 */
export function lineCellRange({ rows = [], first, last, width = 0 } = {}) {
  if (!first || !last || !Array.isArray(rows) || rows.length === 0) return null;
  const step = Math.max(1, Math.trunc(Number(width)) || 1);
  const start = rows[0];
  const end = rows[rows.length - 1];
  if (last.row < start || first.row > end) return null;

  // The offsets are measured from this display line's *first* wrapped row. The anchor
  // reaches this line from an earlier one at cell 0; the focus leaves it for a later one
  // at the line's end. Both are equality cases — `first.row === start` means the anchor
  // is on this line's first row and keeps its own cell, and `last.row === end` means the
  // focus is on this line's last row and likewise keeps its own — so comparing with `<`
  // and `>` (never `<=`/`>=`) is what stops a one-row line from being marked whole.
  const from = first.row < start ? 0 : (first.row - start) * step + first.cell;
  const to = last.row > end ? Infinity : (last.row - start) * step + last.cell;
  if (to <= from) return null;
  return { from, to };
}

/**
 * The composed display lines with the selection marked, ready for the widget.
 *
 * `ftor` is blessed's own real→fake table (`widget._clines.ftor`): one entry per display
 * line, holding the wrapped rows it produced. Reading it rather than computing it is the
 * same decision the copy path makes, and for the same reason — the two must agree about
 * where a row ends, or the reader would see one thing marked and copy another.
 *
 * A line whose range is empty comes back **byte-for-byte**, so a transcript with no
 * selection is painted exactly as it was before this module existed.
 */
export function highlightRows({
  lines = [], anchor = null, focus = null, ftor = null, width = 0,
} = {}) {
  const list = Array.isArray(lines) ? lines : [];
  const range = selectionRange(anchor, focus, Number.MAX_SAFE_INTEGER);
  if (!range) return list;
  // Without blessed's table the wrapped rows cannot be located on a display line, and a
  // guess would mark the wrong text: paint nothing rather than something wrong.
  if (!Array.isArray(ftor) || ftor.length === 0) return list;

  return list.map((line, index) => {
    const rows = Array.isArray(ftor[index]) ? ftor[index] : [];
    const span = lineCellRange({ rows, first: range.first, last: range.last, width });
    if (!span) return line;
    return highlightCells(line, span.from, span.to);
  });
}
