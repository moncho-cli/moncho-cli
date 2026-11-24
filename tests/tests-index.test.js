import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * `tests/README.md` is the index of the proof realm, and it fell behind.
 *
 * Two failures had accumulated in it, and only one of them was visible:
 *
 *  - a doubled `|` merged two rows into one cell, so `command-output-window.test.js` had no
 *    row at all and rendered as part of the one before it — invisible in the rendered
 *    table, which is exactly why it survived;
 *  - 64 of 145 suites were never listed. An index that names 55% of the suites still looks
 *    complete to a reader, which is what makes this worth a test rather than a habit.
 *
 * So the index is checked against the directory. The rule is deliberately about *presence*,
 * not about wording: a row may say anything useful, but it must say something, and a suite
 * that exists must be findable from here.
 */

const testsDir = path.resolve(import.meta.dirname);
const readme = fs.readFileSync(path.join(testsDir, 'README.md'), 'utf-8');

/** Every suite on disk, as it is named. */
const suitesOnDisk = fs.readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort();

/** Every suite named as a row label in the index, in the order they appear. */
const suitesInIndex = [...readme.matchAll(/^\| `([^`]+\.test\.js)`\s*\|/gm)]
  .map((match) => match[1]);

test('every suite in tests/ is listed in the tests index', () => {
  const missing = suitesOnDisk.filter((name) => !suitesInIndex.includes(name));
  assert.deepEqual(
    missing, [],
    `not listed in tests/README.md: ${missing.join(', ') || '(none)'}`
  );
});

test('every suite the index names really exists', () => {
  // The other direction: a renamed or deleted suite leaves a row that sends a reader
  // looking for a file that is not there.
  const stale = suitesInIndex.filter((name) => !suitesOnDisk.includes(name));
  assert.deepEqual(
    stale, [],
    `listed in tests/README.md but absent on disk: ${stale.join(', ') || '(none)'}`
  );
});

test('no row is merged into another by a doubled pipe', () => {
  // The invisible one: `| a | b || c | d |` is a single row whose second cell contains a
  // whole other row, so the merged suite has no row and no reader ever sees the loss.
  const merged = readme.split('\n').filter((line) => /^\|.*\|\|\s*`/.test(line));
  assert.deepEqual(merged, [], 'a row contains another row in one cell');
});

test('every listed suite has a non-empty description', () => {
  // A row without a description is a name in a list: it tells a reader the file exists and
  // nothing about why, which is the state the index was rescued from.
  const empty = [...readme.matchAll(/^\| `([^`]+\.test\.js)`\s*\|\s*\|/gm)].map((m) => m[1]);
  assert.deepEqual(empty, [], 'a row names a suite and says nothing about it');
});

test('the index lists no suite twice', () => {
  const seen = new Set();
  const duplicates = suitesInIndex.filter((name) => {
    if (seen.has(name)) return true;
    seen.add(name);
    return false;
  });
  assert.deepEqual(duplicates, [], 'a suite is listed more than once');
});
