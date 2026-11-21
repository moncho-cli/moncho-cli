import { EditError } from './edit-error.js';
import {
  MAX_CANDIDATES,
  CANDIDATE_FLOOR,
  MIN_CANDIDATES,
  splitLines,
  lineOfIndex,
  similarity,
  nearestCandidates,
  diagnoseMiss,
  sourceExcerpt,
} from './edit-miss.js';

/**
 * Exact, literal text replacement — the editing primitive behind `edit_file`
 * (`docs/agent/line-edits`).
 *
 * It exists because of a measured failure mode, not a preference. Across the recorded
 * sessions, every `patch_file` failure was one of two things: `INVALID_PATCH_LINE` (a
 * hunk body line with a missing or wrong prefix) or `HUNK_COUNT_MISMATCH` (the `@@ -N,M`
 * counts disagreeing with the body). Both are *bookkeeping about the diff format*, not a
 * disagreement about the file, and the real context mismatch (`HUNK_MISMATCH`) was
 * roughly a tenth as common. A search/replace pair has no counts to get wrong and no
 * per-line prefixes, so it removes the two classes that dominated.
 *
 * Everything here is **pure**: text in, text out. The file I/O, the sandbox and the
 * atomic verified write belong to `tools/edit_file.js`, and the *why it did not match*
 * diagnostics to `utils/edit-miss.js`, which keeps this module to one job. The two
 * shared types — `EditError` and the diagnostics — are re-exported so a caller needs
 * only this entry point.
 *
 * Three decisions worth naming:
 *
 *  - **the search is literal, never a pattern.** The text a model supplies is source
 *    code, and source code is full of `*`, `(`, `[` and `$`. Treating the search as a
 *    regular expression would silently match something else — so this uses
 *    `String#indexOf` and says so in the error guidance.
 *  - **an ambiguous search is refused, not guessed.** Matching more than once is reported
 *    with every line it matched and the instruction to quote more context (or to pass
 *    `all: true` deliberately). Guessing "probably the first one" is how an edit lands in
 *    the wrong function.
 *  - **a CRLF file is matched as if it were LF.** A model types `\n`; a file written on
 *    Windows has `\r\n`, and a byte-exact search would never match. The file's own line
 *    endings are detected and restored, so the bytes on disk keep their CRLF.
 */

export { EditError } from './edit-error.js';
export {
  MAX_CANDIDATES,
  CANDIDATE_FLOOR,
  MIN_CANDIDATES,
  splitLines,
  lineOfIndex,
  similarity,
  nearestCandidates,
  diagnoseMiss,
  sourceExcerpt,
} from './edit-miss.js';

/** How many edits one call may carry. A larger batch is a rewrite, not an edit. */
export const MAX_EDITS = 50;

/**
 * Every index at which `needle` occurs in `haystack`, as `{ index, line }`.
 *
 * Non-overlapping, left to right — the same convention every replace-all uses, so two
 * edits can never fight over the same bytes.
 */
export function occurrences(haystack, needle) {
  const source = String(haystack ?? '');
  const target = String(needle ?? '');
  if (target === '') return [];
  const found = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(target, from);
    if (at === -1) return found;
    found.push({ index: at, line: lineOfIndex(source, at) });
    from = at + target.length;
  }
}

/**
 * Apply one `{ search, replace, all }` edit to `content`, in memory.
 *
 * @returns {{content: string, replacements: number, lines: number[]}}
 * @throws {EditError} `EMPTY_SEARCH`, `NO_CHANGES`, `SEARCH_NOT_FOUND`, `SEARCH_NOT_UNIQUE`
 */
export function applyOne(content, edit = {}) {
  const source = String(content ?? '');
  const search = edit.search;
  const replace = edit.replace;

  if (typeof search !== 'string' || search === '') {
    throw new EditError(
      'EMPTY_SEARCH',
      'Every edit needs a non-empty "search" string: the exact text to find.',
    );
  }
  if (typeof replace !== 'string') {
    throw new EditError('INVALID_ARGUMENTS', 'Every edit needs a "replace" string (use "" to delete the text).');
  }
  if (search === replace) {
    throw new EditError(
      'NO_CHANGES',
      'The "search" and "replace" strings are identical, so this edit would change nothing.',
      { guidance: 'Change "replace" to the text you want there, or drop this edit.' },
    );
  }

  const found = occurrences(source, search);
  if (found.length === 0) {
    const candidates = nearestCandidates(source, search);
    const diagnosis = diagnoseMiss(source, search);
    const excerpt = sourceExcerpt(source, search);
    throw new EditError(
      'SEARCH_NOT_FOUND',
      'The "search" text does not appear in the file.',
      {
        candidates,
        ...(diagnosis ? { hint: diagnosis } : {}),
        ...(excerpt ? { source: excerpt.lines, sourceNote: excerpt.note, sourceFrom: excerpt.from, sourceTo: excerpt.to } : {}),
        // Handing the bytes back only pays off if the caller stops guessing: a retry of
        // the same search spends a call to be told what this answer already said.
        retry: 'do not retry this search text unchanged',
        guidance: 'The source above is what is on disk now: build the next call from those bytes, not from the text this search came from. read_file is only needed for a region this excerpt does not show.',
      },
    );
  }

  const all = edit.all === true;
  if (found.length > 1 && !all) {
    throw new EditError(
      'SEARCH_NOT_UNIQUE',
      `The "search" text appears ${found.length} times, so it is ambiguous.`,
      {
        occurrences: found.map((entry) => ({ line: entry.line })),
        guidance:
          'Quote more of the surrounding text so the search is unique, or pass "all": true to replace every occurrence.',
      },
    );
  }

  const targets = all ? found : [found[0]];
  let out = '';
  let cursor = 0;
  for (const target of targets) {
    out += source.slice(cursor, target.index) + replace;
    cursor = target.index + search.length;
  }
  out += source.slice(cursor);

  return { content: out, replacements: targets.length, lines: targets.map((entry) => entry.line) };
}

/**
 * Apply `edits` in order, all or nothing.
 *
 * Each edit is matched against the result of the previous one, so a later edit sees the
 * earlier replacement — which is what "in order" has to mean. Nothing is written until
 * every edit has succeeded, so a batch that fails on the third edit leaves the file
 * exactly as it was.
 *
 * A file whose line endings are CRLF and whose search text carries none is matched as if
 * it were LF; the CRLF is restored in the result, so the bytes on disk keep their endings.
 *
 * @returns {{content: string, crlf: boolean, report: object[]}}
 */
export function applyEditsToText(content, edits = []) {
  const raw = String(content ?? '');
  const list = Array.isArray(edits) ? edits : [];
  if (list.length === 0) {
    throw new EditError('INVALID_ARGUMENTS', 'Supply at least one edit.');
  }
  if (list.length > MAX_EDITS) {
    throw new EditError(
      'TOO_MANY_EDITS',
      `One call may carry at most ${MAX_EDITS} edits, and this one carries ${list.length}.`,
      { guidance: 'Split the change across several edit_file calls, or use write_file for a wholesale rewrite.' },
    );
  }

  // Only normalise when the file really is CRLF and the caller typed LF: a search that
  // already carries \r\n is matched byte-for-byte against the file as it is.
  const anySearchHasCrlf = list.some((edit) => String(edit?.search ?? '').includes('\r\n'));
  const crlf = !anySearchHasCrlf && raw.includes('\r\n');
  const work = crlf ? raw.replace(/\r\n/g, '\n') : raw;

  let out = work;
  const report = [];
  list.forEach((edit, index) => {
    let result;
    try {
      result = applyOne(out, edit);
    } catch (error) {
      if (error instanceof EditError && list.length > 1) {
        // Name which edit of the batch failed, so the caller knows where it got to.
        error.details = { ...error.details, editIndex: index + 1, editsInBatch: list.length };
      }
      throw error;
    }
    out = result.content;
    report.push({ editIndex: index + 1, replacements: result.replacements, lines: result.lines });
  });

  return {
    // The file's own endings win: collapse any CRLF the replacement introduced before
    // restoring the ones the file already had, so a \r in the replacement cannot double.
    content: crlf ? out.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') : out,
    crlf,
    report,
  };
}
