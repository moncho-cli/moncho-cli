/**
 * The **append time of each chunk**, kept *beside* the chunks and never on them.
 *
 * A resumed conversation should say when each block was written, but a chunk is the
 * message the provider is sent verbatim (`app/context-window.js#request`), so no bookkeeping
 * field may ride on it: an unknown key can be rejected by a strict OpenAI-compatible
 * endpoint, and the session file would stop holding the conversation byte-for-byte.
 * The times therefore live in a parallel array, index-aligned with the chunk list,
 * and this module owns the three rules that keep the two aligned:
 *
 *  - **one entry per chunk**, always: a chunk without a time is `null`, never a
 *    shorter array that would silently shift every later mark onto the wrong row;
 *  - **a compaction rebuilds** the list instead of slicing it, because the summary
 *    chunk is new, the carried user message and the kept tail survive *by reference*
 *    (`utils/compaction.js#lastUserChunk`), and their marks must follow them;
 *  - **junk is no mark**: a record written before the field existed, or one carrying a
 *    non-date, yields `null` for that row rather than a wrong time.
 *
 * Pure: no clock of its own (the fallback is handed in), no filesystem, so every rule
 * is provable on arrays.
 */

/** The stored shape of a mark: a valid ISO 8601 string, or `null` for "no mark". */
export const NO_STAMP = null;

/**
 * True when `value` can be a mark: an ISO date string, or a `Date`.
 *
 * Both shapes are the same instant — the clock hands over a `Date`, the record hands
 * back a string — so the module accepts either and always stores the ISO form.
 */
export function isStamp(value) {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value !== 'string' || value.trim() === '') return false;
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * `count` entries of `at`, so a batch of chunks appended in one call is marked once.
 * An unreadable clock yields no marks rather than a wrong time.
 */
export function stampRepeated(at, count = 1) {
  const mark = isStamp(at) ? new Date(at).toISOString() : NO_STAMP;
  return Array.from({ length: Math.max(0, Number(count) || 0) }, () => mark);
}

/**
 * Force a marks list to exactly `length` entries: short lists are padded with
 * `null`, long ones trimmed, and every entry that is not a date becomes `null`.
 *
 * This is the one guard that keeps a hand-edited or older session file from
 * shifting marks onto the wrong rows.
 *
 * @param {any[]} stamps
 * @param {number} length the chunk count the marks must match
 * @returns {(string|null)[]}
 */
export function normalizeStamps(stamps = [], length = 0) {
  const size = Math.max(0, Number(length) || 0);
  const list = Array.isArray(stamps) ? stamps : [];
  return Array.from({ length: size }, (_, index) => {
    const value = list[index];
    return isStamp(value) ? new Date(value).toISOString() : NO_STAMP;
  });
}

/**
 * Rebuild the marks for a new chunk list from the marks of the old one.
 *
 * A chunk that survives a rewrite — the tail a compaction keeps, the user message it
 * carries over — survives **by reference**, so its own mark is looked up by identity
 * and kept. Anything new (the summary chunk, a chunk a caller added) gets `fallback`,
 * which is the moment that rewrite happened, not the time of an older row.
 *
 * @param {object} parts
 * @param {any[]} parts.previousChunks
 * @param {any[]} parts.previousStamps
 * @param {any[]} parts.nextChunks
 * @param {string|null} [parts.fallback]
 */
export function alignStamps({
  previousChunks = [],
  previousStamps = [],
  nextChunks = [],
  fallback = NO_STAMP,
} = {}) {
  const marks = normalizeStamps(previousStamps, previousChunks.length);
  const known = new Map();
  previousChunks.forEach((chunk, index) => {
    if (chunk && typeof chunk === 'object' && !known.has(chunk)) known.set(chunk, marks[index]);
  });
  const fresh = isStamp(fallback) ? new Date(fallback).toISOString() : NO_STAMP;
  return nextChunks.map((chunk) => {
    if (!chunk || typeof chunk !== 'object') return NO_STAMP;
    return known.has(chunk) ? known.get(chunk) : fresh;
  });
}