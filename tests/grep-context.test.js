import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_CONTEXT_LINES,
  buildContextWindows,
  formatWindowLine,
  normalizeContextLines,
  renderWindows,
  execute as grepExecute
} from '../tools/grep.js';

/**
 * Proof for the grep context arguments (docs/agent/project-discovery).
 *
 * `before`/`after` widen each match into a window of surrounding lines, so a hit
 * can be read in place instead of costing a follow-up read_file call. Matching
 * lines keep the `path:line: text` shape; context lines use `path-line- text`
 * and non-contiguous windows are separated by `--`.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-grep-context-test-'));
process.chdir(root);

const FIXTURE = [
  'line 01',
  'line 02',
  'needle a',
  'line 04',
  'needle b',
  'needle c',
  'line 07',
  'line 08',
  'line 09',
  'line 10',
  'line 11',
  'needle d'
].join('\n');

fs.mkdirSync('app', { recursive: true });
fs.writeFileSync('app/lines.txt', FIXTURE, 'utf-8');
fs.writeFileSync('app/other.txt', 'needle elsewhere\n', 'utf-8');

const LINES = FIXTURE.split('\n');

// ---------------------------------------------------------------------------
// the pure window logic
// ---------------------------------------------------------------------------

test('normalizeContextLines defaults to zero and clamps to the hard cap', () => {
  assert.equal(normalizeContextLines(undefined), 0);
  assert.equal(normalizeContextLines(0), 0);
  assert.equal(normalizeContextLines(-5), 0);
  assert.equal(normalizeContextLines('nonsense'), 0);
  assert.equal(normalizeContextLines(3), 3);
  assert.equal(normalizeContextLines(2.9), 2);
  assert.equal(normalizeContextLines(9999), MAX_CONTEXT_LINES);
});

test('buildContextWindows merges touching windows and marks the matching lines', () => {
  const hits = [3, 5, 6, 12].map((line) => ({ line, text: LINES[line - 1] }));
  const windows = buildContextWindows(LINES, hits, { before: 1, after: 1 });

  // 2..4, 4..6 and 5..7 touch, so they become one window; 11..12 stands alone.
  assert.deepEqual(windows.map((w) => [w.start, w.end]), [[2, 7], [11, 12]]);

  const first = windows[0].lines;
  assert.deepEqual(first.map((entry) => entry.line), [2, 3, 4, 5, 6, 7]);
  assert.deepEqual(first.map((entry) => entry.match), [false, true, false, true, true, false]);

  // A line inside two windows is printed once.
  assert.equal(first.filter((entry) => entry.line === 4).length, 1);

  // The last hit is clamped to the end of the file, not padded with blanks.
  assert.deepEqual(windows[1].lines.map((entry) => entry.line), [11, 12]);
});

test('buildContextWindows without context is one single-line window per hit', () => {
  const hits = [{ line: 1, text: LINES[0] }, { line: 12, text: LINES[11] }];
  const windows = buildContextWindows(LINES, hits, { before: 0, after: 0 });
  assert.deepEqual(windows.map((w) => [w.start, w.end]), [[1, 1], [12, 12]]);
  assert.deepEqual(windows[0].lines, [{ line: 1, text: 'line 01', match: true }]);
});

test('formatWindowLine uses ":" for matches and "-" for context, and renderWindows joins groups with "--"', () => {
  assert.equal(formatWindowLine('a.js', { line: 4, text: 'x', match: true }), 'a.js:4: x');
  assert.equal(formatWindowLine('a.js', { line: 5, text: 'x', match: false }), 'a.js-5- x');

  const rendered = renderWindows([
    { path: 'a.js', start: 1, end: 2, lines: [{ line: 1, text: 'one', match: true }] },
    { path: 'a.js', start: 9, end: 9, lines: [{ line: 9, text: 'nine', match: true }] }
  ]);
  assert.deepEqual(rendered, ['a.js:1: one', '--', 'a.js:9: nine']);
});

// ---------------------------------------------------------------------------
// the tool surface
// ---------------------------------------------------------------------------

test('grep returns before/after context lines around each match', async () => {
  const result = await grepExecute({
    pattern: 'needle',
    include: 'lines.txt',
    before: 1,
    after: 1,
    intent: 'read each hit in place'
  });

  assert.match(result, /^<grep pattern="needle" path="\." matches=4 files=1 before=1 after=1>\n/);
  assert.ok(result.includes('app/lines.txt:3: needle a'));
  assert.ok(result.includes('app/lines.txt-2- line 02'), 'context before a match');
  assert.ok(result.includes('app/lines.txt-4- line 04'), 'context after a match');
  assert.ok(result.includes('\n--\n'), 'non-contiguous windows are separated');
  assert.ok(result.includes('app/lines.txt:12: needle d'));
  assert.ok(result.endsWith('\n</grep>'));
});

test('grep context windows merge so no line is repeated', async () => {
  const result = await grepExecute({
    pattern: 'needle',
    include: 'lines.txt',
    before: 1,
    after: 1,
    intent: 'check the merged window'
  });

  const body = result.split('\n').slice(1, -1);
  const contextLines = body.filter((line) => line.includes('-') && !line.startsWith('--'));
  assert.deepEqual(contextLines, [
    'app/lines.txt-2- line 02',
    'app/lines.txt-4- line 04',
    'app/lines.txt-7- line 07',
    'app/lines.txt-11- line 11'
  ]);
  assert.equal(body.filter((line) => line === 'app/lines.txt-4- line 04').length, 1);
});

test('grep clamps the context width and omits the tag attributes when there is none', async () => {
  const wide = await grepExecute({
    pattern: 'needle a',
    include: 'lines.txt',
    before: 9999,
    after: 9999,
    intent: 'ask for more context than allowed'
  });
  assert.ok(wide.startsWith(`<grep pattern="needle a" path="." matches=1 files=1 before=${MAX_CONTEXT_LINES} after=${MAX_CONTEXT_LINES}>`));

  const narrow = await grepExecute({ pattern: 'needle a', include: 'lines.txt', intent: 'no context requested' });
  assert.ok(narrow.startsWith('<grep pattern="needle a" path="." matches=1 files=1>'));
  assert.ok(!narrow.includes('before='));
  assert.ok(narrow.includes('app/lines.txt:3: needle a'));
  assert.ok(!narrow.includes('line 02'), 'no context lines by default');
});

test('grep counts only matches towards maxResults and filesOnly ignores context', async () => {
  const capped = await grepExecute({
    pattern: 'needle',
    include: 'lines.txt',
    before: 2,
    after: 2,
    maxResults: 1,
    intent: 'cap the matches, keep their context'
  });
  assert.match(capped, /matches=1 files=1 truncated=true before=2 after=2>/);
  assert.ok(capped.includes('app/lines.txt:3: needle a'));
  // Only the first hit is a match; the neighbouring hits survive as context.
  const cappedBody = capped.split('\n').slice(1, -1);
  assert.deepEqual(cappedBody.filter((line) => /^app\/lines\.txt:\d+:/.test(line)), ['app/lines.txt:3: needle a']);
  assert.ok(cappedBody.includes('app/lines.txt-5- needle b'), 'the capped hit is still readable as context');


  const filesOnly = await grepExecute({
    pattern: 'needle',
    filesOnly: true,
    before: 1,
    after: 1,
    intent: 'paths only, even with context'
  });
  assert.ok(filesOnly.includes('\napp/lines.txt\n'));
  assert.ok(filesOnly.includes('\napp/other.txt\n'));
  assert.ok(!filesOnly.includes('-1- '), 'filesOnly prints no lines at all');
});
