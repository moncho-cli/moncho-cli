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
