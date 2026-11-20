import { displayWidth, truncateToWidth as truncateCells } from './cell-width.js';

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
 * The counting itself lives in `app/cell-width.js`, shared with the prompt caret: both
 * need "how wide is this text really", and a queue row and a caret have nothing else in
 * common. There the unit is the grapheme cluster, so a `👍🏽` is one glyph of two cells
 * and not three characters — which is what keeps a row holding an emoji inside the box
 * instead of pushing its tail out of sight.
 *
 * Pure: string in, string out, no neo-blessed and no screen, so every rule here is
 * unit tested without a pty.
 */

export { displayWidth };

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
 * `text` cut down to at most `maxCells` display cells, with an `…` when something was
 * dropped. The shared rule counts grapheme clusters, and this export only supplies the
 * queue's own fallback budget; the ellipsis is charged to it, so the result never
 * exceeds it — which is the point: a row the box can hold stays one row.
 */
export function truncateToWidth(text, maxCells = QUEUE_PREVIEW_CHARS) {
  return truncateCells(text, maxCells);
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
