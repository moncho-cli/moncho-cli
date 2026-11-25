/**
 * Repair a search that missed only on **formatting**, before it is refused.
 *
 * The measured failure this answers (backlog item 83): a model composes a search from a
 * sketch — a `hint_file` page, a remembered line, its own earlier `replace` — and the text
 * is right while the *bytes* are wrong. `utils/edit-miss.js` already diagnoses that: the
 * same text with 4 leading spaces instead of 2, a trailing space the file does not have, a
 * CRLF file searched with LF. Diagnosis costs the model a round; the repair it implies
 * costs none, so this module applies the one repair the diagnosis names.
 *
 * The safety rule is the whole design, and it is narrow on purpose:
 *
 *  - **only line-edge whitespace and line endings are ever normalised.** A line matches
 *    when its `trim()` equals the search line's `trim()`, so the interior of a line —
 *    where `const  a` differs from `const a`, and where a string literal lives — is
 *    compared byte for byte and a search that differs there is never repaired. Rewriting
 *    interior whitespace would be rewriting code.
 *  - **one place, or nothing.** Several matching blocks mean the repair cannot say which
 *    it meant, and guessing "probably the first" is how an edit lands in the wrong
 *    function. The caller gets those line numbers back so it can quote more context.
 *  - **the replacement is never re-indented.** The caller wrote `replace` for the code it
 *    believed the file held; shifting its indentation is a guess about a block that may
 *    contain a template literal. The repair says what the indentation really is and leaves
 *    that judgement to the caller.
 *
 * Pure text work — no filesystem, no tool — so every rule is unit tested directly.
 */

import { lineOfIndex, splitLines } from './edit-miss.js';

/** Every way a search can miss on formatting alone. */
export const REPAIR_RULES = Object.freeze([
  'line-endings',
  'indentation',
  'trailing-whitespace',
  'whitespace',
]);

/** The leading whitespace of a line: the runs of tabs and spaces at its start. */
function indentOf(line) {
  return (String(line ?? '').match(/^[ \t]*/) || [''])[0];
}

/** The trailing whitespace of a line. */
function tailOf(line) {
  return (String(line ?? '').match(/[ \t]*$/) || [''])[0];
}

/** CRLF and lone CR folded to LF, which is how the engine matches a CRLF file. */
export function normalizeLineEndings(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Every block of `content` that equals `search` once each line is trimmed.
 *
 * Returns the 0-based line index of each block's first line, so a caller can report the
 * lines it found and refuse to choose between them. An empty search, an empty file or a
 * search longer than the file yields `[]`.
 */
export function whitespaceCandidates(content, search) {
  const source = String(content ?? '');
  const needle = normalizeLineEndings(search);
  if (needle === '') return [];

  const needleLines = splitLines(needle).map((line) => line.trim());
  const contentLines = splitLines(source);
  if (needleLines.length > contentLines.length) return [];

  const hits = [];
  const last = contentLines.length - needleLines.length;
  for (let start = 0; start <= last; start += 1) {
    let match = true;
    for (let offset = 0; offset < needleLines.length; offset += 1) {
      if (contentLines[start + offset].trim() !== needleLines[offset]) {
        match = false;
        break;
      }
    }
    if (match) hits.push(start);
  }
  return hits;
}

/** Which formatting rule explains a match, given the lines the file really holds. */
export function classifyRepair(contentLines, needleLines, start = 0) {
  let leading = false;
  let trailing = false;
  for (let offset = 0; offset < needleLines.length; offset += 1) {
    const actual = String(contentLines[start + offset] ?? '');
    const expected = String(needleLines[offset] ?? '');
    if (actual === expected) continue;
    if (indentOf(actual) !== indentOf(expected)) leading = true;
    if (tailOf(actual) !== tailOf(expected)) trailing = true;
  }
  if (leading && trailing) return 'whitespace';
  if (leading) return 'indentation';
  if (trailing) return 'trailing-whitespace';
  // The trimmed text is identical on every line, so what is left is the ending itself.
  return 'line-endings';
}

/** A sentence naming what was repaired, worded for the model that has to read it. */
function noteFor(rule, { actualIndent = null, expectedIndent = null, line = 0 } = {}) {
  switch (rule) {
    case 'line-endings':
      return 'the search carried CR/CRLF line endings; it now matches the file\'s own endings';
    case 'indentation':
      if (actualIndent !== null && expectedIndent !== null && actualIndent !== expectedIndent) {
        return `the search was indented ${expectedIndent} space(s) but line ${line} has ${actualIndent}; the search now matches the file`;
      }
      return 'the search\'s leading whitespace differed from the file\'s; the search now matches the file';
    case 'trailing-whitespace':
      return 'the search carried trailing whitespace the file does not have; the search now matches the file';
    default:
      return 'the search\'s line-edge whitespace differed from the file\'s; the search now matches the file';
  }
}

/**
 * The single repair that makes `search` match `content`, or `null`.
 *
 * `null` is the answer for every case this module will not decide: nothing matches even
 * after the repair, or more than one block does. Both are the caller's to report — the
 * first as `SEARCH_NOT_FOUND`, the second as an ambiguity it can resolve by quoting more
 * context (`whitespaceCandidates` gives it the lines).
 *
 * A `search` that already matches literally is not a repair, so it is not returned: the
 * caller applies the exact path and never records one.
 *
 * `content` is expected in the form the engine matches in: `applyEditsToText` folds a
 * CRLF file to LF before calling, and the repaired `search` is returned in that same LF
 * form. The line-ending rule therefore answers the remaining case — a search that
 * *carries* CR or CRLF while the text it means is LF.
 *
 * @param {string} content the file as the engine matches it (LF line endings)
 * @param {string} search the text the edit failed to find
 * @returns {{search: string, rule: string, note: string, line: number, actualIndent: number, expectedIndent: number}|null}
 */
export function repairSearch(content, search) {
  const source = String(content ?? '');
  const needle = String(search ?? '');
  if (needle === '') return null;
  // Already literal: there is nothing to repair.
  if (source.includes(needle)) return null;

  const lfNeedle = normalizeLineEndings(needle);
  if (lfNeedle !== needle && source.includes(lfNeedle)) {
    return {
      search: lfNeedle,
      rule: 'line-endings',
      note: noteFor('line-endings'),
      line: lineOfIndex(source, source.indexOf(lfNeedle)),
      actualIndent: null,
      expectedIndent: null,
    };
  }

  const hits = whitespaceCandidates(source, needle);
  if (hits.length !== 1) return null;

  const start = hits[0];
  const contentLines = splitLines(source);
  const needleLines = splitLines(lfNeedle);
  const repaired = contentLines.slice(start, start + needleLines.length).join('\n');
  if (repaired === '' || repaired === needle) return null;

  const rule = classifyRepair(contentLines, needleLines, start);
  const line = start + 1;
  const actualIndent = indentOf(contentLines[start]).length;
  const expectedIndent = indentOf(needleLines[0]).length;

  return {
    search: repaired,
    rule,
    note: noteFor(rule, { actualIndent, expectedIndent, line }),
    line,
    actualIndent,
    expectedIndent,
  };
}