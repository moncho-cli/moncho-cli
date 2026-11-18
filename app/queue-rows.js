/**
 * How a queued message is **drawn**: the display-ready rows of the queue bar.
 *
 * Kept apart from the queue model (`app/message-queue.js`), which owns the order and
 * the bytes, because a row is the one part of the queue that has to know about the
 * screen — through a single number, the interior width of the bar, in cells.
 *
 * That number is what the backlog item is about: a preview capped at a fixed 48
 * characters threw away most of a wide terminal ("too soon"), and a row wider than the
 * box wrapped onto a second display line that the region's height then clipped, so the
 * end of the message vanished with no `…` at all ("strangely truncated"). A row fitted
 * to the width it really has is always **one display line**, so nothing is ever clipped
 * and the reader can see what is about to be sent.
 *
 * Pure: string in, string out, no neo-blessed and no screen, so every rule here is
 * unit tested without a pty.
 */

/**
 * Longest preview kept for one row **when there is no width to fit to**, in cells:
 * the first paint happens before the widget is laid out, and the line CLI has no bar
 * at all. A bar that knows its width uses the whole of it (`queuePreviewBudget`).
 */
export const QUEUE_PREVIEW_CHARS = 48;

/** Message rows the bar shows before the rest collapse into a `+N more` tail. */
export const QUEUE_MAX_ROWS = 4;

/** The marker carried by every row; clicking the row deletes that message. */
export const QUEUE_DELETE_MARKER = '✕';

/**
 * Code points a terminal paints in one cell that still occupy **two**: the CJK,
 * Hangul and fullwidth ranges neo-blessed itself counts as double-wide
 * (`lib/unicode.js#charWidth`). Counting them as two is what keeps a row holding such
 * a glyph inside the box instead of pushing its tail out of sight.
 */
const WIDE_CELL_RE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u3000]/;

/** A combining mark paints in no cell of its own. */
const ZERO_CELL_RE = /[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc]/;

/** How many cells `text` occupies on screen: wide glyphs two, combining marks none. */
export function displayWidth(text) {
  let width = 0;
  for (const char of String(text ?? '')) {
    if (ZERO_CELL_RE.test(char)) continue;
    width += WIDE_CELL_RE.test(char) ? 2 : 1;
  }
  return width;
}

/**
 * `text` cut down to at most `maxCells` display cells, with an `…` when something was
 * dropped. The ellipsis is charged to the budget, so the result never exceeds it —
 * which is the point: a row the box can hold stays one row.
 */
export function truncateToWidth(text, maxCells = QUEUE_PREVIEW_CHARS) {
  const source = String(text ?? '');
  const limit = Math.max(1, Math.trunc(Number(maxCells)) || QUEUE_PREVIEW_CHARS);
  if (displayWidth(source) <= limit) return source;

  const kept = [];
  let used = 0;
  for (const char of source) {
    const cells = displayWidth(char);
    if (used + cells > limit - 1) break; // one cell is kept for the ellipsis
    kept.push(char);
    used += cells;
  }
  return `${kept.join('')}…`;
}

/**
 * The cells a row may give to its preview: the row's width, less the `✕ N. ` prefix,
 * which must stay readable whatever happens. A bar that reports no width (before its
 * first layout, or the line CLI, which has no bar) falls back to
 * `QUEUE_PREVIEW_CHARS`.
 */
export function queuePreviewBudget({ columns = 0, prefix = '' } = {}) {
  const total = Math.trunc(Number(columns)) || 0;
  if (total <= 0) return QUEUE_PREVIEW_CHARS;
  return Math.max(1, total - displayWidth(prefix));
}

/** The tail row shown when more messages are queued than the bar paints. */
export function formatQueueTail(hidden) {
  return `+${Number(hidden) || 0} more`;
}

/**
 * One display-ready line for a queued message: whitespace runs (including the
 * newlines of a pasted block) collapse to single spaces and the result is truncated
 * to `maxChars` **display cells**, with an ellipsis when something was dropped.
 *
 * The cap is a cell budget, not a character count, so a wide glyph is charged for the
 * room it really takes and the row cannot wrap.
 *
 * Display only — the model keeps the raw text untouched.
 */
export function previewMessage(text, { maxChars = QUEUE_PREVIEW_CHARS } = {}) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return truncateToWidth(flat, maxChars);
}

/**
 * One queue row: the delete marker, the 1-based position, then the preview fitted to
 * the width the row has. Accepts a queue item (`{ id, text }`) or a bare string.
 *
 * @param {object} options `columns`: the interior width of the bar, in cells; 0 (or
 *   omitted) keeps the no-width fallback, which is what a caller with no screen gets.
 */
export function formatQueueRow(message, index = 0, { columns = 0 } = {}) {
  const text = message && typeof message === 'object' ? message.text : message;
  const position = Math.trunc(Number(index)) + 1;
  const label = Number.isFinite(position) && position > 0 ? `${position}. ` : '';
  const prefix = `${QUEUE_DELETE_MARKER} ${label}`;
  const budget = queuePreviewBudget({ columns, prefix });
  return `${prefix}${previewMessage(text, { maxChars: budget })}`;
}

/**
 * The rows of the queue bar, top to bottom: one `✕` row per message, in queue
 * order, and — when more than `maxRows` are waiting — a final `+N more` tail
 * naming how many rows are not painted.
 *
 * `columns` is the interior width of the bar: with it every row is fitted to the
 * width it really has, and without it (a caller with no screen) the rows keep the
 * `QUEUE_PREVIEW_CHARS` cap.
 */
export function formatQueueRows(messages = [], { maxRows = QUEUE_MAX_ROWS, columns = 0 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const cap = Math.max(0, Math.trunc(Number(maxRows)) || 0);
  const shown = Math.min(list.length, cap);
  const rows = list.slice(0, shown).map((message, index) => formatQueueRow(message, index, { columns }));
  const hidden = list.length - shown;
  if (hidden > 0) rows.push(formatQueueTail(hidden));
  return rows;
}
