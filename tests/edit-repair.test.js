import test from 'node:test';
import assert from 'node:assert/strict';

import {
  repairSearch,
  whitespaceCandidates,
  normalizeLineEndings,
  classifyRepair,
  REPAIR_RULES,
} from '../utils/edit-repair.js';
import { applyOne, applyEditsToText, EditError } from '../utils/edit_lib.js';

/**
 * The deterministic repair of a formatting-only miss (backlog item 83).
 *
 * The premise is measured: a search composed from a sketch has the right *text* and the
 * wrong *bytes*, and the miss diagnostics already name the difference. This suite proves
 * the repair that follows from it is narrow in exactly the way the safety argument needs:
 *
 *  - it normalises **line-edge** whitespace and line endings only, so the interior of a
 *    line — where code really differs — is never rewritten;
 *  - it repairs only when exactly **one** block matches, because "probably the first one"
 *    is how an edit lands in the wrong function;
 *  - it never re-indents the replacement, which is a guess about a block that may hold a
 *    template literal.
 *
 * The last case is the one that matters most: a repaired edit must produce the same bytes
 * as if the model had typed the file's own text, which is what makes the repair invisible
 * to everything downstream.
 */

test("a search indented differently is repaired to the file's own bytes", () => {
  const content = 'function f() {\n  return 1;\n}\n';
  const repaired = repairSearch(content, '    return 1;');

  assert.equal(repaired.rule, 'indentation');
  assert.equal(repaired.search, '  return 1;');
  assert.equal(repaired.line, 2);
  assert.equal(repaired.actualIndent, 2);
  assert.equal(repaired.expectedIndent, 4);
  assert.match(repaired.note, /indented 4 space\(s\) but line 2 has 2/);
});

test('a search carrying trailing whitespace the file lacks is repaired', () => {
  const content = 'const a = 1;\nconst b = 2;\n';
  const repaired = repairSearch(content, 'const a = 1;   ');

  assert.equal(repaired.rule, 'trailing-whitespace');
  assert.equal(repaired.search, 'const a = 1;');
  assert.match(repaired.note, /trailing whitespace/);
});

test("a CRLF search against a CRLF file is repaired to the file's endings", () => {
  // The engine folds a CRLF file to LF before matching, so what reaches this module is
  // already the LF form of the file; a search that still carries CRLF is the remaining case.
  const content = 'alpha\nbeta\n';
  const repaired = repairSearch(content, 'alpha\r\nbeta');

  assert.equal(repaired.rule, 'line-endings');
  assert.equal(repaired.search, 'alpha\nbeta');
});

test('a repair that would match in two places is refused rather than guessed', () => {
  // Both lines are the same text with different indentation: repairing would have to pick.
  const content = 'if (a) {\n  return 1;\n}\nif (b) {\n    return 1;\n}\n';
  assert.equal(repairSearch(content, '      return 1;'), null);

  const hits = whitespaceCandidates(content, '      return 1;');
  assert.deepEqual(hits, [1, 4], 'the caller must learn every place it could have meant');
});

test('only line-edge whitespace is normalised, so interior bytes are never rewritten', () => {
  // `const  a` and `const a` are different code, not different formatting.
  assert.equal(repairSearch('const  a = 1;\n', 'const a = 1;'), null);
  // A string literal's interior whitespace is code for the same reason.
  assert.equal(repairSearch("const s = 'a  b';\n", "const s = 'a b';"), null);
});

test('a search that already matches literally is not a repair', () => {
  // Reporting a repair here would make every ordinary edit claim one.
  assert.equal(repairSearch('  return 1;\n', '  return 1;'), null);
});

test('a search matching nothing at all is not repaired', () => {
  assert.equal(repairSearch('alpha\n', 'zeta'), null);
  assert.equal(repairSearch('', 'alpha'), null);
  assert.equal(repairSearch('alpha\n', ''), null);
});

test('a multi-line search is repaired as a block, not line by line', () => {
  const content = 'if (a) {\n    return 1;\n}\n';
  const repaired = repairSearch(content, 'if (a) {\n  return 1;\n}');
  assert.equal(repaired.search, 'if (a) {\n    return 1;\n}');
  assert.equal(repaired.rule, 'indentation');
});

test('the classification names the rule the repair actually applied', () => {
  const lines = ['    return 1;  ', '  next;'];
  assert.equal(classifyRepair(lines, ['  return 1;', '  next;']), 'whitespace');
  assert.equal(classifyRepair(lines, ['  return 1;  ', '  next;']), 'indentation');
  assert.equal(classifyRepair(['  a;  '], ['  a;']), 'trailing-whitespace');
  assert.equal(classifyRepair(['alpha'], ['alpha']), 'line-endings');
  assert.deepEqual(REPAIR_RULES, ['line-endings', 'indentation', 'trailing-whitespace', 'whitespace']);
});

test('line endings are folded to LF, CRLF and a lone CR alike', () => {
  assert.equal(normalizeLineEndings('a\r\nb'), 'a\nb');
  assert.equal(normalizeLineEndings('a\rb'), 'a\nb');
  assert.equal(normalizeLineEndings('a\nb'), 'a\nb');
});

test("a repaired edit writes the file's own bytes, not the search that was typed", () => {
  // The bug this guards is a slice advanced by the *typed* search's length: the shorter
  // file text would leave a leftover tail behind, corrupting the file silently.
  const content = 'function f() {\n  return 1;\n}\n';
  const applied = applyOne(content, { search: '    return 1;', replace: '  return 99;' });

  assert.equal(applied.content, 'function f() {\n  return 99;\n}\n');
  assert.deepEqual(applied.repaired, {
    rule: 'indentation',
    note: 'the search was indented 4 space(s) but line 2 has 2; the search now matches the file',
    line: 2,
  });
});

test('an unambiguous formatting miss is applied instead of refused', () => {
  const content = 'alpha\nbeta\ngamma\n';
  const result = applyEditsToText(content, [{ search: 'beta   ', replace: 'BETA' }]);

  assert.equal(result.content, 'alpha\nBETA\ngamma\n');
  assert.equal(result.report[0].repaired.rule, 'trailing-whitespace');
});

test('the repair never re-indents the replacement', () => {
  // A search with more indentation than the file is a real miss, so this one is repaired;
  // the model wrote `replace` for the indentation it believed in, and shifting it would be
  // a guess about a block that may contain a template literal — so it lands verbatim.
  const content = 'if (a) {\n    return 1;\n}\n';
  const applied = applyOne(content, { search: '      return 1;', replace: 'RETURN_ONE' });

  assert.equal(applied.repaired.rule, 'indentation');
  assert.equal(applied.content, 'if (a) {\nRETURN_ONE\n}\n');
});

test('an ambiguous formatting miss stays a refusal, and names every place', () => {
  const content = 'if (a) {\n  return 1;\n}\nif (b) {\n    return 1;\n}\n';
  assert.throws(
    () => applyOne(content, { search: '      return 1;', replace: 'return 2;' }),
    (error) => {
      assert.ok(error instanceof EditError);
      assert.equal(error.code, 'SEARCH_NOT_FOUND');
      assert.deepEqual(error.details.whitespaceMatches, [{ line: 2 }, { line: 5 }]);
      assert.match(error.details.hint, /2 places/);
      return true;
    },
  );
});

test('a refusal with no whitespace match at all reports none', () => {
  assert.throws(
    () => applyOne('alpha\n', { search: 'zeta', replace: 'y' }),
    (error) => {
      assert.equal(error.code, 'SEARCH_NOT_FOUND');
      assert.equal(error.details.whitespaceMatches, undefined);
      return true;
    },
  );
});

test('an exact match is still an exact match, with no repair recorded', () => {
  const applied = applyOne('  return 1;\n', { search: '  return 1;', replace: '  return 2;' });
  assert.equal(applied.repaired, undefined);
  assert.equal(applied.content, '  return 2;\n');
});