import { bandWidthOf } from './prose-band.js';

/**
 * Reading a blessed scrollable widget's geometry: where its content starts, how far it is
 * scrolled, how much of it fits, and how wide it wrapped.
 *
 * Three places needed the same numbers and each was doing the arithmetic itself — the
 * transcript view (to decide whether an append may scroll), the block click
 * (`app/transcript.js#clickRow`, which maps a screen row to a display line) and the mouse
 * selection (`app/transcript-select.js#pointAt`, which maps the same event to a content
 * cell). Three copies of "where is the content?" is three chances for a click and a drag
 * to disagree about which row they are on, which is exactly the bug that would be hardest
 * to see: a selection one row off still looks like a selection.
 *
 * So the numbers are read once, here, and everything that needs them asks. The unit is
 * always the same: a **row** is a wrapped row of the content (the unit `childBase` and
 * blessed's `rtof` are expressed in), a **cell** is a terminal cell from the content's
 * left edge.
 *
 * Every reader is defensive — a widget that has not laid out yet (`lpos` missing), a stub
 * in a test, a half-built screen — because a mouse event can arrive before the first paint
 * and none of these may be the thing that throws.
 */

/**
 * Where the content begins inside the widget: `xi`/`yi` are the widget's painted origin
 * and `ileft`/`itop` are the border plus the padding, so `xi + ileft` is the first cell of
 * the first content column.
 */
export function contentOrigin(widget) {
  const pos = widget?.lpos;
  if (!pos) return null;
  const left = Number(widget.ileft) || 0;
  const top = Number(widget.itop) || 0;
  return {
    xi: Number(pos.xi) || 0,
    yi: Number(pos.yi) || 0,
    left,
    top,
    // The first cell the content can paint in, which is what a mouse x is measured from.
    contentX: (Number(pos.xi) || 0) + left,
    contentY: (Number(pos.yi) || 0) + top,
  };
}

/** The first content row currently painted (blessed's scroll base). */
export function scrollBase(widget) {
  return Math.max(0, Number(widget?.childBase) || 0);
}

/** The scroll offset the widget reports, `childBase` plus any sub-cell offset. */
export function scrollOffset(widget) {
  if (typeof widget?.getScroll === 'function') return Number(widget.getScroll()) || 0;
  return scrollBase(widget);
}

/** Rows of content visible at once, as far as the widget can tell us. */
export function visibleHeight(widget) {
  if (!widget) return 0;
  const height = Number(widget.height) || 0;
  const inner = Number(widget.iheight) || 0;
  return height > 0 ? Math.max(0, height - inner) : 0;
}

/** Total scrollable height in rows (blessed's `getScrollHeight()`). */
export function scrollHeight(widget) {
  if (!widget) return 0;
  if (typeof widget.getScrollHeight === 'function') return Number(widget.getScrollHeight()) || 0;
  return scrollBase(widget) + visibleHeight(widget);
}

/**
 * The last content row that is **drawn**, as a row index, or null when nothing is drawn.
 *
 * This is the lower bound a drag may reach, and the reason a drag that leaves the pane
 * copies to the end rather than to whatever row the arithmetic happened to land on: the
 * reader dragged *past* the text, so the selection runs to the last line the widget put on
 * screen. Null means "no opinion" — no layout yet, or a stub — and the caller clamps to 0
 * only.
 */
export function drawnRows(widget) {
  const lines = widget?._clines;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const base = scrollBase(widget);
  return base + lines.length - 1;
}

/**
 * The width, in cells, of the widest row the widget drew, or null when nothing is drawn.
 *
 * The right-hand bound of a drag, used the same way `drawnRows()` is the lower one: a
 * pointer past the right edge selects the rest of the line, not a column that does not
 * exist. Null, like `drawnRows()`, means "no opinion" — a widget that has not laid out yet,
 * or a stub in a unit test — and then no cell is clamped away.
 */
export function drawnWidth(widget) {
  const lines = widget?._clines;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  return lines.reduce((widest, line) => Math.max(widest, String(line ?? '').length), 0);
}

/**
 * The width the widget really wrapped its lines at, which is the step between one display
 * line's wrapped rows.
 *
 * Deliberately **not** blessed's stored `_clines.width`: blessed records the width it was
 * handed and then subtracts the scrollbar's own column *inside* `_wrapContent`, so on a
 * region with a scrollbar the stored number is one cell wider than the rows were cut to
 * (measured: a stored 76 against 75-cell rows). `bandWidthOf()` is the width the prose band
 * is padded to — the same cell count — so the two agree by construction.
 */
export function wrapWidthOf(widget) {
  return bandWidthOf(widget);
}

/**
 * The content point a mouse event names: `{ row, cell }`, or null when the event or the
 * geometry is unusable.
 *
 * `row` is a wrapped row of the content and `cell` a terminal cell from the content's left
 * edge, so the pair can be compared directly against blessed's own tables. A point above or
 * left of the content clamps to 0 rather than going negative, so a click on the border is
 * the first cell rather than nothing. A point **past the drawn content** — the pointer
 * below the last line, or past the right edge — is clamped to the last row and the row's
 * width, which is what makes a drag that leaves the pane copy to the end of the passage it
 * started in instead of covering the rows below it.
 *
 * The clamp is against what is **drawn**, deliberately, and not against the whole content:
 * on a scrolled pane those differ, and the drawn rows are the ones the reader pointed at.
 */
export function contentPoint(widget, data) {
  const origin = contentOrigin(widget);
  if (!origin || !data) return null;
  const row = Number(data.y) - origin.contentY + scrollBase(widget);
  const cell = Number(data.x) - origin.contentX;
  if (!Number.isFinite(row) || !Number.isFinite(cell)) return null;

  const lastRow = drawnRows(widget);
  const clampedRow = lastRow === null
    ? Math.max(0, Math.trunc(row))
    : Math.min(Math.max(0, Math.trunc(row)), lastRow);
  const widest = drawnWidth(widget);
  const clampedCell = widest === null
    ? Math.max(0, Math.trunc(cell))
    : Math.min(Math.max(0, Math.trunc(cell)), Math.max(0, widest - 1));
  return { row: clampedRow, cell: clampedCell };
}
