import { LOG_LEVEL } from '../config/constants.js';

/**
 * The *record* half of the operational log (docs/runtime/logging): what a level is,
 * what a threshold means, and the exact bytes one line is.
 *
 * Split from `utils/logger.js` — the *sink* half, which decides where the line goes
 * and rotates the file — so each side stays small enough to read at once. Nothing
 * here touches the filesystem, so every rule below is provable without a directory.
 */

/** The levels, in the order a threshold walks them: `error` is the loudest. */
export const LOG_LEVELS = ['error', 'warn', 'info'];
/** The threshold that turns the log off completely. */
export const SILENT_LEVEL = 'silent';
/** Loudness per level: a line is written when its rank is at or below the threshold. */
export const LOG_LEVEL_ORDER = Object.freeze({ error: 0, warn: 1, info: 2, silent: 3 });

/** Spellings accepted for a level, so `LOG_LEVEL=warning` is not a silent typo. */
const LEVEL_ALIASES = Object.freeze({
  warning: 'warn',
  err: 'error',
  off: SILENT_LEVEL,
  none: SILENT_LEVEL,
  disabled: SILENT_LEVEL,
});

/** The canonical level, or null when the value names none. */
function canonicalLevel(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const resolved = LEVEL_ALIASES[raw] || raw;
  return LOG_LEVELS.includes(resolved) || resolved === SILENT_LEVEL ? resolved : null;
}

/**
 * The canonical level for `value`, falling back to `fallback` (itself normalised,
 * then `info`) for anything else — a broken environment variable must not be able to
 * disable or invert the threshold by accident.
 */
export function normalizeLogLevel(value, fallback = 'info') {
  return canonicalLevel(value) || canonicalLevel(fallback) || 'info';
}

/**
 * A budget or a file count, or `fallback` when the value cannot be read as one.
 *
 * Three answers, and the middle one is why this is not a "positive integer" helper:
 *
 *  - **a positive integer** is the limit;
 *  - **an explicit `0` stays `0`, which means "no limit"** — the one way to turn rotation
 *    off without a second flag (docs/runtime/logging). `0` is a *value somebody chose*,
 *    not a missing one, so it must not be rewritten into the default;
 *  - **junk, empty, or negative** falls back, because a typo must not silently remove the
 *    cap and leave a log growing without bound in a workspace the user believed was
 *    bounded.
 *
 * The `0` case is the one that was wrong before: `> 0` was applied here as well as at the
 * sink, so an explicit `0` was quietly replaced by the default, the documented "off" was
 * unreachable, and the rotation guard downstream — written for a zero budget — was dead
 * code. A primitive that cannot express a legal value is the bug.
 */
export function normalizeLogLimit(value, fallback) {
  // A fallback is itself a limit, so it follows the same rule — including being `0`.
  const asLimit = (input) => {
    // Strict, because `Number.parseInt` is not: it reads `abc` as NaN but `12abc` as 12,
    // and a limit silently taken from a mangled value is worse than the default.
    const raw = String(input ?? '').trim();
    if (!/^\d+$/.test(raw)) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const chosen = asLimit(value);
  if (chosen !== null) return chosen;

  const safe = asLimit(fallback);
  return safe === null ? 0 : safe;
}

/** True when `candidate` is at or below the threshold; `silent` allows nothing. */
export function levelEnabled(candidate, threshold = LOG_LEVEL) {
  const limit = normalizeLogLevel(threshold);
  if (limit === SILENT_LEVEL) return false;
  return LOG_LEVEL_ORDER[normalizeLogLevel(candidate)] <= LOG_LEVEL_ORDER[limit];
}

/** One line, whatever the input did: a newline in a message would break the shape. */
export function flattenLogValue(value) {
  return String(value ?? '').replace(/\r\n|\r|\n/g, '\\n');
}

/** The level tag of a line, padded so the message column stays aligned. */
function padLevel(level) {
  return normalizeLogLevel(level).toUpperCase().padEnd(5, ' ');
}

/**
 * An Error as a plain object: the shape survives both the line and the JSON details
 * of a log entry, and the stack is escaped into a single line by `flattenLogValue()`.
 */
export function serializeLogError(error) {
  if (error == null || typeof error !== 'object') return { message: flattenLogValue(error) };
  const out = { name: error.name || 'Error', message: flattenLogValue(error.message) };
  if (error.code !== undefined) out.code = error.code;
  if (error.stack) out.stack = flattenLogValue(error.stack);
  return out;
}

/** Details with every Error replaced by its serialisable shape. */
function normalizeDetails(details) {
  if (details == null) return null;
  if (details instanceof Error) return serializeLogError(details);
  if (typeof details !== 'object') return { value: details };
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    out[key] = value instanceof Error ? serializeLogError(value) : value;
  }
  return out;
}

/** JSON that cannot throw: an unserialisable detail must not lose the whole line. */
function safeStringify(value) {
  if (value == null) return '';
  try {
    return JSON.stringify(value) || '';
  } catch {
    return '{"details":"<unserialisable>"}';
  }
}

/**
 * One complete log line, always ending in a newline:
 *
 * ```
 * 2026-02-14T10:30:00.000Z WARN  [provider] attempt 1/3 failed {"name":"Error","message":"HTTP error! status: 502"}
 * ```
 */
export function formatLogLine({
  at = new Date(),
  level = 'info',
  scope = null,
  message = '',
  details = null,
} = {}) {
  const when = at instanceof Date ? at : new Date(at);
  const stamp = Number.isNaN(when.getTime()) ? new Date(0).toISOString() : when.toISOString();
  const parts = [`${stamp} ${padLevel(level)}`];
  if (scope) parts.push(`[${flattenLogValue(scope)}]`);
  const body = flattenLogValue(message);
  if (body !== '') parts.push(body);
  const tail = safeStringify(normalizeDetails(details));
  if (tail !== '') parts.push(tail);
  return `${parts.join(' ')}\n`;
}
