/**
 * Why a search did not match — the diagnostics behind `edit_file`'s two refusals.
 *
 * Extracted from `utils/edit_lib.js` because "which line did you mean, and how does it
 * differ" is a different job from "replace this text": the engine decides *whether* an
 * edit lands, and this module gives the caller the evidence to fix it in one retry.
 *
 * A refusal that only says "not found" costs a re-read and another model call, so
 * `SEARCH_NOT_FOUND` answers with candidates — the lines that most resemble the search —
 * and, when the best one is the same text with different bytes, with *which* difference:
 * indentation, trailing whitespace or line endings. That diagnosis is the thing
 * `patch_file`'s `HUNK_MISMATCH` never gave.
 *
 * Pure text work: no filesystem, no tool, so every rule below is unit tested directly.
 */

/** How many candidate lines a `SEARCH_NOT_FOUND` reports. */
export const MAX_CANDIDATES = 5;

/** Score at which a candidate line is strong enough to be reported on its own. */
export const CANDIDATE_FLOOR = 12;

/** How many lines a miss reports when too few clear the floor above. */
export const MIN_CANDIDATES = 3;

/** How many lines of the file a miss quotes around the region it was looking for. */
export const SOURCE_WINDOW = 8;

/** The lines of `text`, exactly as `split('\n')` sees them. */
export function splitLines(text) {
  return String(text ?? '').split('\n');
}

/** The 1-based line number of a character offset. */
export function lineOfIndex(text, index) {
  const source = String(text ?? '');
  const stop = Math.min(Math.max(0, index), source.length);
  let line = 1;
  for (let i = 0; i < stop; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

/** The words of a line: what "similar" is measured on, so punctuation cannot decide it. */
function tokens(text) {
  return new Set(String(text ?? '').split(/[^A-Za-z0-9_$]+/).filter(Boolean));
}

/** How alike two lines are, 0..50 — always below the exact-match tiers below. */
export function similarity(a, b) {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return Math.round((shared / Math.max(left.size, right.size)) * 50);
}

/**
 * The lines of `content` that most resemble the search, best first.
 *
 * `trimmed` equality scores highest (the text is there, only the surrounding whitespace
 * differs) — that is the single most common near-miss, and naming it is what turns a dead
 * end into a one-line fix.
 *
 * The list is never empty when the file has any non-blank line: when fewer than
 * `MIN_CANDIDATES` clear the floor, the strongest lines are returned anyway, because an
 * empty array tells the caller nothing at all.
 */
export function nearestCandidates(content, search, { limit = MAX_CANDIDATES } = {}) {
  const needleLines = splitLines(search).filter((line) => line.trim() !== '');
  const first = (needleLines[0] ?? '').trim();
  if (!first) return [];

  const scored = [];
  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;
    let score = 0;
    if (trimmed === first) score = 100;
    else if (trimmed.includes(first) || first.includes(trimmed)) score = 60;
    else score = similarity(trimmed, first);
    scored.push({ line: i + 1, text: line, score });
  }

  const ranked = scored.filter((entry) => entry.score >= CANDIDATE_FLOOR);
  const pool = ranked.length >= MIN_CANDIDATES ? ranked : scored;

  pool.sort((a, b) => b.score - a.score || a.line - b.line);
  return pool.slice(0, Math.max(0, limit)).map(({ line, text }) => ({ line, text }));
}

/**
 * Why the search did not match, as one sentence, when the reason can be told.
 *
 * Compared against the best candidate line, which is the only evidence available: the
 * same text with different leading whitespace is an indentation mismatch, the same text
 * with a different tail is a trailing-whitespace or line-ending mismatch. `null` when
 * nothing plausible was found, and the caller falls back to "re-read the file".
 */
export function diagnoseMiss(content, search) {
  const [best] = nearestCandidates(content, search, { limit: 1 });
  if (!best) return null;
  const needleFirst = (splitLines(search).find((line) => line.trim() !== '') ?? '');
  if (best.text.trim() !== needleFirst.trim()) return null;

  if (best.text !== needleFirst) {
    const expectedIndent = needleFirst.length - needleFirst.trimStart().length;
    const actualIndent = best.text.length - best.text.trimStart().length;
    if (expectedIndent !== actualIndent) {
      return `line ${best.line} holds the same text but with ${actualIndent} leading space(s), not ${expectedIndent}`;
    }
    if (best.text.trimEnd() !== needleFirst.trimEnd()) {
      return `line ${best.line} holds the same text but with different trailing whitespace`;
    }
    return `line ${best.line} holds the same text but the bytes differ (line ending or an invisible character)`;
  }

  // The first line matches exactly, so the mismatch is further down the search text.
  const needleLines = splitLines(search).filter((line) => line.trim() !== '');
  if (needleLines.length > 1) {
    return `the first match is at line ${best.line}, so the difference is in the following lines of the search`;
  }
  return null;
}

/**
 * The file's own text around the region a search failed on, with line numbers.
 *
 * A candidate line says *which* line was meant; it does not say what the surrounding
 * declarations, the indentation of the block or the rest of the statement look like — and
 * those are what the next attempt has to be built from. Without the source the model has
 * to call `read_file` before it can even try again, which is exactly the extra round the
 * refusal is meant to save (backlog item 65).
 *
 * The window is anchored on the best candidate when there is one (the strongest guess at
 * where the caller meant) and on the top of the file when the miss matches nothing at all,
 * so the excerpt is always the text the caller was about to change rather than a random
 * page. It is bounded to `window` lines and numbered in the file's own 1-based lines, the
 * metric `read_file` pages in (`docs/agent/line-paging`), so the numbers can be used as
 * the `offset` of a follow-up read.
 *
 * Pure: `content` in, a small object out.
 *
 * @param {string} content the file as it is on disk
 * @param {string} search the text the edit failed to find
 * @param {{window?: number}} [options]
 * @returns {{from: number, to: number, lines: string, note: string}|null} `null` for an
 *   empty file, where there is no source to hand back
 */
export function sourceExcerpt(content, search, { window = SOURCE_WINDOW } = {}) {
  const lines = splitLines(content);
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) return null;

  const size = Number.isInteger(window) && window > 0 ? window : SOURCE_WINDOW;
  const [best] = nearestCandidates(content, search, { limit: 1 });
  // Anchor where the caller most likely meant; a search with no resemblance at all gets
  // the head of the file, which is at least real bytes to build an edit from.
  const anchor = best ? best.line : 1;
  const from = Math.max(1, Math.min(anchor - Math.ceil(size / 2) + 1, lines.length - size + 1));
  const to = Math.min(lines.length, from + size - 1);
  const numbered = lines
    .slice(from - 1, to)
    .map((line, i) => String(from + i).padStart(6) + '  ' + line)
    .join('\n');
  return {
    from,
    to,
    lines: numbered,
    note: `the file's own bytes at lines ${from}-${to}, as they are now`,
  };
}
