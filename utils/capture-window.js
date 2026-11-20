/**
 * Paging and scanning over a captured output (`docs/agent/command-capture`).
 *
 * This is the *file-like* half of a capture: the model asked for a truncated document,
 * so the header gives it the counts and the handle, and this module answers "show me
 * lines N..M" or "show me the lines matching this pattern" over the string that stayed
 * in memory (`utils/capture-store.js`). The arithmetic is the same idea as
 * `utils/command-output.js#resolveWindow`, applied to a handle instead of a command.
 *
 * Pure text work: no store, no `fs`, no child process, so both selections are unit
 * tested on plain strings.
 */

import { EMPTY_OUTPUT } from './command-output.js';

/** How many lines a page returns when the caller does not say. */
export const DEFAULT_CAPTURE_PAGE = 200;

/** The widest page a caller may ask for in one call. */
export const MAX_CAPTURE_PAGE = 1000;

/** How many matching lines a scan returns when the caller does not say. */
export const DEFAULT_MAX_MATCHES = 200;

/** Raised when a selection cannot be honoured (a nonsense page or a broken pattern). */
export class CaptureRangeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CaptureRangeError';
    this.code = code;
  }
}

/** The lines of a captured output, with a single trailing newline ignored. */
export function splitCaptureLines(text) {
  const raw = String(text ?? '');
  if (raw === '') return [];
  return (raw.endsWith('\n') ? raw.slice(0, -1) : raw).split('\n');
}

/** `   12  the line` — the numbering read_file uses, so a page can be cited. */
export function numberLines(lines, from = 1) {
  return lines.map((line, index) => `${String(from + index).padStart(6)}  ${line}`).join('\n');
}

/** A positive integer, or `null` when the caller did not supply one. */
function positiveCount(value, name, max) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CaptureRangeError('INVALID_RANGE', `"${name}" must be a whole number of at least 1, got ${JSON.stringify(value)}.`);
  }
  if (max !== undefined && parsed > max) {
    throw new CaptureRangeError('INVALID_RANGE', `"${name}" is capped at ${max} lines per call, got ${parsed}.`);
  }
  return parsed;
}

/** Build the scan pattern, reporting a broken regular expression as its own code. */
function buildPattern(pattern, { ignoreCase = false, fixedStrings = false } = {}) {
  const source = fixedStrings ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
  try {
    return new RegExp(source, ignoreCase ? 'i' : '');
  } catch (error) {
    throw new CaptureRangeError('INVALID_PATTERN', `Invalid pattern ${JSON.stringify(pattern)}: ${error.message}`);
  }
}

/**
 * Select a window of a captured output: a page of lines, or the lines matching a
 * pattern. A `pattern` wins over `offset`/`limit`, because scanning is what a caller
 * asking for one really wants.
 *
 * @param {string} text the whole capture
 * @param {{offset?: number, limit?: number, pattern?: string, ignoreCase?: boolean,
 *   fixedStrings?: boolean, maxMatches?: number}} [options]
 * @returns {{mode: 'page'|'scan', body: string, total: number, shown: number,
 *   truncated: boolean, from: number, to: number, matches?: number}}
 */
export function selectCapture(text, options = {}) {
  const lines = splitCaptureLines(text);
  const total = lines.length;

  if (typeof options.pattern === 'string' && options.pattern !== '') {
    return scanCapture(lines, options);
  }

  const limit = positiveCount(options.limit, 'limit', MAX_CAPTURE_PAGE) ?? DEFAULT_CAPTURE_PAGE;
  const rawOffset = Number.isInteger(options.offset) ? options.offset : 0;
  // A negative offset counts from the end, exactly like read_file, so "the last 50
  // lines" is one call rather than a count the caller has to compute.
  const start = Math.min(Math.max(0, rawOffset < 0 ? total + rawOffset : rawOffset), total);
  const end = Math.min(start + limit, total);
  const page = lines.slice(start, end);

  return {
    mode: 'page',
    body: page.length > 0 ? numberLines(page, start + 1) : EMPTY_OUTPUT,
    total,
    shown: page.length,
    truncated: end < total || start > 0,
    from: page.length > 0 ? start + 1 : 0,
    to: end
  };
}

/** The lines matching a pattern, numbered so the caller can page around them. */
function scanCapture(lines, { pattern, ignoreCase, fixedStrings, maxMatches }) {
  const regexp = buildPattern(pattern, { ignoreCase, fixedStrings });
  const cap = positiveCount(maxMatches, 'maxMatches') ?? DEFAULT_MAX_MATCHES;
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (!regexp.test(lines[i])) continue;
    hits.push({ line: i + 1, text: lines[i] });
    if (hits.length >= cap) break;
  }

  return {
    mode: 'scan',
    body: hits.length > 0 ? hits.map((hit) => `${String(hit.line).padStart(6)}  ${hit.text}`).join('\n') : EMPTY_OUTPUT,
    total: lines.length,
    shown: hits.length,
    truncated: hits.length >= cap && hits.length < lines.length,
    from: hits.length > 0 ? hits[0].line : 0,
    to: hits.length > 0 ? hits[hits.length - 1].line : 0,
    matches: hits.length
  };
}
