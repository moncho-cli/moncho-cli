import { isStamp } from './chunk-stamps.js';

/**
 * How a **stored** time is shown on a reloaded conversation.
 *
 * The live mark is `HH:MM:SS` (`app/transcript-stamp.js#formatStamp`): it is taken the
 * moment an entry appears, so it never needs a date. A replay is a different case — the
 * rows come from a past run, possibly a past day — and an `HH:MM:SS` alone would suggest
 * two rows a day apart were written a second apart. So a reloaded conversation carries
 * **two** marks, both from the same stored instant:
 *
 *  - the day **divider** (`--- 2026-11-20, Thursday ---`), printed once, before the first
 *    row of each day the conversation spans: it is what makes the clock unambiguous, and
 *    it only appears where the day actually changes;
 *  - the usual eight-character `HH:MM:SS` on the block itself, so a reloaded transcript
 *    reads exactly like the live one it reproduces.
 *
 * The mark stays presentation: it is built from an ISO string the record kept beside the
 * chunks (`utils/chunk-stamps.js`), it is never sent to the provider, and it never
 * touches a chunk or a row's own text.
 *
 * Local time, end to end: the reader is looking at their own clock, and a transcript that
 * disagreed with it by a timezone offset would be worse than no mark at all. Junk — a
 * missing or unreadable time — answers `''`, which every caller renders as "no mark".
 */

/** The eight-character mark itself, matching the live stamp's shape and width. */
export function formatStampAt(at) {
  if (!isStamp(at)) return '';
  const date = new Date(at);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** The local calendar day of a stored instant: `YYYY-MM-DD`, or `''` for junk. */
export function stampDay(at) {
  if (!isStamp(at)) return '';
  const date = new Date(at);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

/**
 * The weekday of a `YYYY-MM-DD` day, read in UTC so the name never shifts onto the
 * previous day for a reader west of Greenwich. `''` when the text is not a day.
 */
export function weekdayOf(day) {
  const text = String(day ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const at = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return '';
  return WEEKDAYS[at.getUTCDay()];
}

/**
 * The one row that introduces a day: `--- 2026-11-20, Thursday ---`.
 *
 * It opens with a rule on purpose — the palette paints a rule as chrome
 * (`app/theme.js#classifyLine`), so the divider can never be mistaken for prose the
 * model wrote, and a reloaded reply keeps its own delimiters untouched.
 */
export function dayDividerFor(day) {
  const text = String(day ?? '');
  const weekday = weekdayOf(text);
  if (!weekday) return '';
  return `--- ${text}, ${weekday} ---`;
}