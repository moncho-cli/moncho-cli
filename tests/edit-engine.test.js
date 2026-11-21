import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEditsToText,
  applyOne,
  diagnoseMiss,
  nearestCandidates,
  occurrences,
  similarity,
  MAX_EDITS,
  MAX_CANDIDATES,
  MIN_CANDIDATES,
  EditError,
  sourceExcerpt,
} from '../utils/edit_lib.js';

/**
 * The pure half of `edit_file`: the engine and its miss diagnostics
 * (docs/agent/line-edits).
 *
 * Everything here is text in, text out — no filesystem and no tool — which is why these
 * rules can be stated so precisely. The *tool-level* half (the sandbox, the staleness
 * guard, the tracking fence, the verified write, the structured response) lives in
 * `tests/edit.test.js`; splitting them keeps both suites about one subject.
 *
 * The point of this suite is the failure side: the two error classes that dominated
 * `patch_file` (`INVALID_PATCH_LINE`, `HUNK_COUNT_MISMATCH`) cannot even be *expressed*
 * here, so what is left to prove is that the two refusals which do exist are specific
 * enough to fix in one retry.
 */

test('the search is literal, so regex metacharacters match themselves', () => {
  // `.` would match any character as a regex; here it must match the literal dot only.
  const applied = applyOne('x = aXb\ny = a.b\n', { search: 'a.b', replace: 'A_DOT_B' });
  assert.equal(applied.replacements, 1, 'the regex-eligible aXb must not match');
  assert.equal(applied.content, 'x = aXb\ny = A_DOT_B\n');

  // The same for the other metacharacters a search is likely to contain.
  const parens = applyOne('run(a);\nrunXa);\n', { search: 'run(a);', replace: 'go();' });
  assert.equal(parens.replacements, 1);
  assert.equal(parens.content, 'go();\nrunXa);\n');
});

test('a miss caused by indentation is diagnosed', () => {
  const content = 'function f() {\n    return 1;\n}\n';
  // The text exists, but indented four spaces rather than two.
  const reason = diagnoseMiss(content, '  return 1;');
  assert.equal(reason, 'line 2 holds the same text but with 4 leading space(s), not 2');

  const [candidate] = nearestCandidates(content, '  return 1;');
  assert.equal(candidate.line, 2);
  assert.equal(candidate.text, '    return 1;');
});

test('an unrelated search still reports the strongest candidate lines', () => {
  // Nothing resembles `zzz`, so the floor is not cleared anywhere: the report must still
  // answer with evidence rather than an empty array, or the caller learns nothing.
  const candidates = nearestCandidates('alpha = 1;\nbeta = 2;\n', 'zzz = 3;', { limit: MIN_CANDIDATES });
  assert.ok(candidates.length > 0, 'a miss always reports candidates when the file has lines');
  assert.ok(candidates.length <= MIN_CANDIDATES);
  assert.equal(similarity('alpha = 1;', 'alpha = 1;'), 50);
  assert.equal(similarity('', 'alpha'), 0);
});

test('a miss hands back the real bytes around the region, numbered', () => {
  const content = ['function f() {', '    const a = 1;', '    return a;', '}', ''].join('\n');
  const excerpt = sourceExcerpt(content, '    const a = 2;', { window: 4 });

  assert.equal(excerpt.from, 1);
  assert.equal(excerpt.to, 4);
  assert.ok(excerpt.lines.includes('     2      const a = 1;'), 'the real bytes, with line numbers');
  assert.ok(excerpt.lines.includes('     3      return a;'), 'the neighbouring declarations too');
  assert.ok(!excerpt.lines.includes('const a = 2'), 'never the text the caller invented');
  assert.match(excerpt.note, /the file's own bytes at lines 1-4/);
});

test('the excerpt is bounded, and anchored on the best candidate rather than the top', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `const v${i + 1} = ${i + 1};`);
  lines[29] = 'const target = 30;';
  const excerpt = sourceExcerpt(lines.join('\n'), 'const target = 31;', { window: 4 });

  assert.equal(excerpt.to - excerpt.from + 1, 4, 'the window is exactly what was asked for');
  assert.ok(excerpt.from <= 30 && excerpt.to >= 30, 'it is centred where the model meant');
  assert.ok(excerpt.lines.includes('const target = 30;'), 'the line it was aiming at is in it');
});

test('a file with nothing to quote yields no excerpt at all', () => {
  assert.equal(sourceExcerpt('', 'anything'), null);
});

test('an empty search is refused', () => {
  assert.throws(() => applyOne('text\n', { search: '', replace: 'x' }), /non-empty "search"/);
  assert.throws(() => applyOne('text\n', { search: 'x' }), EditError);
});

test('a search equal to its replacement is refused', () => {
  assert.throws(
    () => applyOne('keep\n', { search: 'keep', replace: 'keep' }),
    /would change nothing/,
  );
});

test('the edit engine is bounded and reports occurrences in order', () => {
  assert.equal(MAX_EDITS, 50);
  assert.equal(MAX_CANDIDATES, 5);
  assert.deepEqual(
    occurrences('a a a', 'a').map((entry) => entry.line),
    [1, 1, 1],
  );
  assert.deepEqual(occurrences('abc', ''), []);
  assert.throws(
    () => applyEditsToText('x\n', Array.from({ length: MAX_EDITS + 1 }, () => ({ search: 'x', replace: 'y' }))),
    /at most 50 edits/,
  );
  assert.throws(() => applyEditsToText('x\n', []), /at least one edit/);
});

test('a replacement is literal, so a dollar sign is never a backreference', () => {
  // A regex replace would read `$1` as a capture group; the engine must write it verbatim.
  const applied = applyOne('price\n', { search: 'price', replace: '$1.00' });
  assert.equal(applied.content, '$1.00\n');
});
