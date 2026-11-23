import { displayWidth, truncateToWidth } from './cell-width.js';
import { STAMP_RE } from './transcript-stamp.js';
import { stripTags } from './paint-tags.js';

/**
 * The **sticky last user message**: the prompt the work is being done for, kept at the top
 * of the conversation while the reader scrolls back through the agent's output.
 *
 * The backlog puts the behaviour in one sentence:
 *
 * > as the conversation scrolls upwards, the last user message should be kept stickied in
 * > the top position, with the timestamp, like, it should stop there, if the user sends a
 * > new message, when that new message enters the conversation the previous one is
 * > released and the new one will eventually occupy that first position again when it
 * > scrolls enough
 *
 * So there are exactly three facts, and this module owns all of them:
 *
 *  - **which** prompt is the last one — the newest entry on the `user` side of the
 *    dialogue, which the transcript already records for the prose band
 *    (`docs/interface/prose-bands`);
 *  - **when** it should be shown — only once it has scrolled off the top, because while
 *    the real row is on screen a pinned copy would say the same thing twice;
 *  - **what** the pinned row says — its timestamp and the first line of the prompt, fitted
 *    to the width the region really has.
 *
 * Pure: the caller reads its own widget's numbers and passes them in, so every rule is
 * unit tested without a terminal (`app/sticky-bar.js` is the widget binding). Presentation
 * only: the row is a *view* of an entry that is already in the transcript, so it is never
 * a chunk, never in a session file and never reaches the model.
 */

/** The glyph that opens the pinned row, so it reads as chrome and not as the message. */
export const STICKY_MARKER = '⌖';

/**
 * The newest user entry in the transcript, or null when the user has not spoken yet.
 *
 * A *user* entry is the prose line carrying `role: 'user'` — the same fact the band is
 * painted from, so the pin can never disagree with the band about whose turn a row is.
 * Blank banded margin rows carry the role too and are skipped: they are padding, not text.
 *
 * @param {Array<{text?: string, role?: string|null, stamp?: string|null}>} records
 * @returns {{text: string, stamp: string|null, index: number}|null}
 */
export function lastUserEntry(records = []) {
  const list = Array.isArray(records) ? records : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const record = list[index];
    if (record?.role !== 'user') continue;
    if (String(record.text ?? '').trim() === '') continue;
    return {
      text: String(record.text ?? ''),
      stamp: typeof record.stamp === 'string' ? record.stamp : null,
      index,
    };
  }
  return null;
}

/**
 * The text of the pinned row, without its stamp: the prompt's first non-blank line,
 * with any mark the echo already carries stripped, fitted to `width` cells.
 *
 * One line on purpose. A pinned row that grew with a multi-line prompt would eat the
 * conversation it exists to explain, so the prompt is summarised the way every other
 * one-line place in the UI summarises it (`app/queue-rows.js` does the same for a
 * queued message). An empty prompt yields `''` and the bar then paints nothing.
 */
export function stickyText(text, width = 0) {
  const lines = String(text ?? '').split('\n');
  const first = lines.map((line) => line.replace(STAMP_RE, '').trim()).find((line) => line !== '');
  if (!first) return '';
  const cells = Math.max(1, Math.trunc(Number(width)) || 0);
  // The record is a **formatted** line, not a coloured one: the renderer emits symbolic
  // palette tags (`{@quote-fg}` for a quote bar), real blessed tags (`{bold}` for a
  // heading) and escaped braces (`{open}`, `{close}` for a literal brace the user typed).
  // The transcript resolves all of those at paint time; the pin is one chrome row and wants
  // the glyphs and none of the markup. Leaving them in would print `{@quote-fg}` on screen
  // — blessed does not know `@` as a tag character — and would make the measurement
  // dishonest, since `displayWidth()` charges every tag character as a visible cell and
  // then truncates the prompt early to make room for bytes nobody sees (`stripTags()`).
  const plain = stripTags(first);
  return truncateToWidth(plain, cells);
}

/**
 * Whether the pin is due.
 *
 * The real row's offset is its index among the display lines; the view is scrolled by
 * `childBase` rows and shows `visibleHeight` of them. The pin appears once that row would
 * be painted at or above the top edge — i.e. it is no longer on screen — and hides again
 * when the reader scrolls back up to it. Both numbers are cells of the same table
 * (`model.lineRecords()`), which is what makes the comparison exact rather than a guess.
 *
 * A caller with no geometry yet (no layout, a stub in a test) is told *not* to pin: the
 * unfinished screen has nothing to explain, and a bar painted before the first paint would
 * be the one thing worse than no bar.
 *
 * @param {{index: number, scrollBase: number, visibleHeight: number}} [options]
 */
export function isStickyDue({ index = -1, scrollBase = 0, visibleHeight = 0 } = {}) {
  if (!Number.isFinite(index) || index < 0) return false;
  const base = Math.max(0, Math.trunc(Number(scrollBase)) || 0);
  const visible = Math.max(0, Math.trunc(Number(visibleHeight)) || 0);
  if (visible === 0) return false;
  // The row occupies display line `index`; it is off the top once the first painted row
  // (`base`) is past it.
  return base > index;
}

/**
 * The display line the pinned row paints: the mark, the timestamp when the entry has one,
 * and the prompt — escaped for blessed's tag parser by the caller, so this stays a plain
 * string function.
 *
 * A prompt shorter than the budget is left alone; a longer one is cut in cells, never in
 * characters, so an emoji never loses half of itself to the pin.
 */
export function stickyLine({ text = '', stamp = null, width = 0 } = {}) {
  const mark = typeof stamp === 'string' && STAMP_RE.test(`${stamp} `) ? stamp : null;
  // The marker owns the leftmost cell, the stamp follows it — the same order a block
  // header uses (`app/transcript.js#formatBlockHeader`), so the glyph that says "this is
  // chrome" is always in the same column.
  const prefix = mark ? `${STICKY_MARKER} ${mark} ` : `${STICKY_MARKER} `;
  const budget = Math.max(1, Math.trunc(Number(width)) || 0);
  // The prefix is charged to the budget, counted in cells, so the row never exceeds the
  // width it is given.
  const body = stickyText(text, Math.max(1, budget - displayWidth(prefix)));
  return body ? `${prefix}${body}` : '';
}