/**
 * The timestamp a conversation block carries in the TUI (task-backlog: "in the user
 * converstaion view (not sent to the model) show a timestamp on each block so the
 * user knows when that block appeared (the model does not need this timestamp at
 * all)").
 *
 * The transcript is a list of *entries* — a prose line, a tool result block, the
 * user's own echo — and a reader scrolling back cannot tell whether two rows are a
 * second or an hour apart. This module owns the mark that answers that, and nothing
 * else: one `HH:MM:SS` string, taken when the entry is *appended* and attached to
 * the entry it belongs to.
 *
 * Pure and terminal-free, so the mark is unit tested without a screen. Three rules
 * are load-bearing:
 *
 *  - **presentation only.** The stamp lives on the transcript entry, never on a
 *    context chunk, so it cannot reach the model or a session file;
 *  - **one mark per entry.** A multi-line reply is stamped once, on its first
 *    line, so a long answer does not become a column of identical times;
 *  - **the mark is part of the line.** It is prepended to the display line rather
 *    than painted beside it, so the block-click math (which counts display lines)
 *    is unchanged; the palette tolerates it through `STAMP_RE`
 *    (`app/theme.js#classifyLine`).
 */

/**
 * The shape of a stamp at the head of a display line: eight characters, then a
 * space. Exported because the palette has to *see through* it — a stamped row must
 * still be recognised as the user's echo, a tool call or an error.
 */
export const STAMP_RE = /^\d{2}:\d{2}:\d{2} /;

/** The width of the mark itself, without its trailing space. */
export const STAMP_WIDTH = 8;

/**
 * One `HH:MM:SS` mark in local time.
 *
 * Local, not UTC: the reader is looking at their own clock, and a transcript that
 * disagreed with it by a timezone offset would be worse than no stamp at all. Junk
 * — a missing date, an invalid one, an epoch — yields `''`, and an empty stamp is
 * what `withStamp()` renders as "no mark", never as `NaN:NaN:NaN`.
 */
export function formatStamp(date = new Date()) {
  const at = date instanceof Date ? date : new Date(date);
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * Prefix `text` with `stamp` when there is one, and return it untouched otherwise.
 *
 * A stamp that does not look like one (a hand-made string, junk from a caller) is
 * dropped instead of being written into the conversation: the mark is decoration,
 * and decoration must never be able to corrupt a row.
 */
export function withStamp(text, stamp) {
  const body = String(text ?? '');
  const mark = typeof stamp === 'string' && STAMP_RE.test(`${stamp} `) ? stamp : '';
  return mark ? `${mark} ${body}` : body;
}

/**
 * The timestamp hook the transcript view calls for every entry it appends.
 *
 * Injected so the clock is the caller's: the TUI passes `() => new Date()` (and a
 * test passes a frozen date), while `null` — a front end that wants no marks, the
 * pure view tests — yields `null` for every entry, and `withStamp()` then leaves
 * the line exactly as it was.
 */
export function createStamper({ now = () => new Date(), enabled = true } = {}) {
  if (!enabled) return () => null;
  return () => formatStamp(now()) || null;
}
