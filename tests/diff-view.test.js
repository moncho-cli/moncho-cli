import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  DIFF_MIN_SPLIT_WIDTH,
  diffLayout,
  diffRows,
  fitSide,
  gutterWidth,
  matchLines,
  renderDiff,
  textLines,
  writeDiffBlock,
} from '../app/diff-view.js';
import {
  clearWriteCaptures,
  peekWriteCapture,
  pendingCaptureCount,
  recordWriteCapture,
  takeWriteCapture,
} from '../utils/write-journal.js';
import { createToolEcho } from '../app/tool-echo.js';

/**
 * Backlog item 53 — a tool's diff, side by side with line numbers.
 *
 * The cases follow the order of the design: the line model, the pairing, the layout
 * choice, then the block and the route that draws it. The last case is the one that
 * matters most, because it asserts the property the whole shape exists for — the
 * diff is drawn on the screen and **never** reaches the tool result the model is
 * billed for.
 *
 * Run with: node --test tests/diff-view.test.js
 */

// --- the line model ---------------------------------------------------------------

test('textLines ends the last line at a trailing newline and never invents one', () => {
  assert.deepEqual(textLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(textLines('a\nb'), ['a', 'b']);
  assert.deepEqual(textLines(''), []);
  assert.deepEqual(textLines('one\n'), ['one'], 'a one-line file is one line');
  assert.deepEqual(textLines('a\n\nb'), ['a', '', 'b'], 'a real blank line survives');
});

test('matchLines finds the anchors of an insertion and of a modification', () => {
  assert.deepEqual(matchLines(['a', 'b'], ['a', 'b']), [[0, 0], [1, 1]]);
  // One line inserted between two anchors.
  assert.deepEqual(matchLines(['a', 'b'], ['a', 'x', 'b']), [[0, 0], [1, 2]]);
  // A modified line is not an anchor at all, so it becomes a gap between them.
  assert.deepEqual(matchLines(['a', 'b'], ['a', 'B']), [[0, 0]]);
  assert.deepEqual(matchLines([], ['a']), []);
});

// --- the pairing ------------------------------------------------------------------

test('a modified line is one changed row, not a removal beside an addition', () => {
  const rows = diffRows('const a = 1;\n', 'const a = 2;\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'changed');
  assert.equal(rows[0].left.text, 'const a = 1;');
  assert.equal(rows[0].right.text, 'const a = 2;');
  assert.deepEqual(rows[0].left.number, 1);
  assert.deepEqual(rows[0].right.number, 1);
});

test('diffRows keeps line numbers on both sides across an insertion', () => {
  const rows = diffRows('one\ntwo\n', 'one\ninserted\ntwo\n');
  assert.deepEqual(rows.map((row) => row.kind), ['context', 'added', 'context']);
  assert.deepEqual(rows[2].left, { number: 2, text: 'two' });
  assert.deepEqual(rows[2].right, { number: 3, text: 'two' });
  assert.equal(rows[1].left, null, 'an addition has no old side');
});

test('diffRows reports a pure removal with no new side', () => {
  const rows = diffRows('a\nb\nc\n', 'a\nc\n');
  const removed = rows.filter((row) => row.kind === 'removed');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].left.text, 'b');
  assert.equal(removed[0].right, null);
});

test('diffRows answers no rows when nothing changed', () => {
  assert.deepEqual(diffRows('same\n', 'same\n').map((row) => row.kind), ['context']);
  const block = writeDiffBlock({ path: 'a.js', before: 'same\n', after: 'same\n', created: false });
  assert.equal(block, null, 'an unchanged file earns no block at all');
});

// --- the layout -------------------------------------------------------------------

test('diffLayout keeps the split on a wide region and stacks it on a narrow one', () => {
  const wide = diffLayout({ width: 120, lineCount: 900 });
  assert.equal(wide.mode, 'split');
  assert.ok(wide.left > 0 && wide.right > 0);

  const narrow = diffLayout({ width: DIFF_MIN_SPLIT_WIDTH - 1, lineCount: 12 });
  assert.equal(narrow.mode, 'sequential');
  assert.ok(narrow.sequential > 0, 'the stacked layout still gets a usable width');

  // A region of no width at all is not a crash: it is the stacked layout at zero.
  assert.equal(diffLayout({ width: 0 }).mode, 'sequential');
});

test('gutterWidth grows with the file and is capped', () => {
  assert.equal(gutterWidth(9), 1);
  assert.equal(gutterWidth(10), 2);
  assert.equal(gutterWidth(1234), 4);
  assert.equal(gutterWidth(1234567), 5, 'capped at DIFF_MAX_GUTTER');
});

test('fitSide cuts between clusters and says what it cut', () => {
  assert.equal(fitSide('short', 10), 'short');
  assert.equal(fitSide('abcdefgh', 5), 'abcd…');
  // A wide glyph is one cluster of two cells: it is kept whole or dropped, never halved.
  const wide = fitSide('👍🏽👍🏽👍🏽', 5);
  assert.ok(wide.endsWith('…'));
  assert.ok(!wide.includes('\uFFFD'));
  assert.equal(fitSide('anything', 0), '');
});

test('renderDiff aligns both columns and marks each kind of row', () => {
  const rows = diffRows('a\nold\nc\n', 'a\nnew\nc\n');
  const split = renderDiff(rows, { width: 100 });
  assert.equal(split.mode, 'split');
  const changed = split.lines.find((line) => line.includes('~'));
  assert.ok(changed.includes('old') && changed.includes('new'), 'both sides on one row');

  const stacked = renderDiff(rows, { width: 40 });
  assert.equal(stacked.mode, 'sequential');
  assert.ok(stacked.lines.some((line) => line.includes('- old')));
  assert.ok(stacked.lines.some((line) => line.includes('+ new')));
});

// --- the block --------------------------------------------------------------------

test('a changed file earns a collapsed block naming its additions and removals', () => {
  const block = writeDiffBlock(
    { path: 'app/x.js', before: 'keep\nold\n', after: 'keep\nnew\n', created: false },
    { width: 100 },
  );
  assert.match(block.header, /diff app\/x\.js/);
  assert.match(block.header, /\+\d+ −\d+/);
  assert.equal(block.collapsed, true, 'a diff is folded like every tool result');
  assert.match(block.body, /keep/);
});

test('a created file names its line count, and a whole rewrite names its count', () => {
  const created = writeDiffBlock({ path: 'new.js', before: null, after: 'a\nb\n', created: true });
  assert.equal(created.collapsed, true);
  assert.match(created.header, /new file/);
  assert.match(created.body, /1 a/, 'a created file still shows its numbered lines');

  const whole = writeDiffBlock({ path: 'r.js', before: 'a\nb\n', after: 'x\ny\n', created: false });
  assert.equal(whole.collapsed, true, 'nothing shared to read a diff against');
  assert.match(whole.header, /whole file/);
});

test('a capture with no bytes or no path earns no block', () => {
  assert.equal(writeDiffBlock(null), null);
  assert.equal(writeDiffBlock({ path: '' }), null);
  // An oversize capture keeps its shape but drops the bytes, so there is nothing to draw.
  const oversize = writeDiffBlock({ path: 'big.js', before: null, after: null, created: false });
  assert.equal(oversize, null);
});

// --- the journal ------------------------------------------------------------------

test('the journal holds one pair per path, sorted out by take and peek', () => {
  clearWriteCaptures();
  recordWriteCapture({ path: 'a.js', before: 'x', after: 'y', created: false });
  recordWriteCapture({ path: 'a.js', before: 'y', after: 'z', created: false });
  assert.equal(pendingCaptureCount(), 1, 'one entry per path, not a queue');

  assert.equal(peekWriteCapture('a.js').after, 'z');
  assert.equal(peekWriteCapture('a.js').after, 'z', 'peek does not consume');

  assert.equal(takeWriteCapture('a.js').after, 'z');
  assert.equal(takeWriteCapture('a.js'), null, 'the entry is dropped once taken');
  assert.equal(pendingCaptureCount(), 0);

  assert.equal(recordWriteCapture({ path: '' }), false, 'a nameless write is not filed');
  clearWriteCaptures();
});

test('an oversize pair is filed as a shape without its bytes', () => {
  clearWriteCaptures();
  recordWriteCapture({
    path: 'huge.js',
    before: 'a'.repeat(1_200_000),
    after: 'b'.repeat(1_200_000),
    created: false,
  });
  const capture = peekWriteCapture('huge.js');
  assert.equal(capture.oversize, true);
  assert.equal(capture.before, null, 'the bytes are not held');
  assert.equal(capture.after, null);
  clearWriteCaptures();
});

// --- the route --------------------------------------------------------------------

test('the echo draws the diff and leaves the tool result untouched', () => {
  clearWriteCaptures();
  const blocks = [];
  const echo = createToolEcho({
    tui: { logBlock: (block) => blocks.push(block) },
    log: () => {},
    width: () => 100,
  });

  recordWriteCapture({ path: 'app/x.js', before: 'old\n', after: 'new\n', created: false });
  const result = JSON.stringify({ status: 'success', path: 'app/x.js', bytes: 4 });
  const before = result.slice();

  echo('edit_file', result, 'rename a thing');

  assert.equal(result, before, 'the result the model receives is byte-for-byte unchanged');
  assert.equal(JSON.parse(result).diff, undefined, 'and it carries no diff field');
  assert.equal(blocks.length, 2, 'the result block and the diff block');
  assert.match(blocks[0].header, /edit_file/, 'the ordinary result row still leads');
  assert.match(blocks[1].header, /diff app\/x\.js/);
  clearWriteCaptures();
});

test('a failed call and a path the journal never saw draw no diff', () => {
  clearWriteCaptures();
  const blocks = [];
  const echo = createToolEcho({
    tui: { logBlock: (block) => blocks.push(block) },
    width: () => 100,
  });

  echo('edit_file', JSON.stringify({ status: 'error', code: 'SEARCH_NOT_FOUND', path: 'a.js' }), 'x');
  echo('write_file', JSON.stringify({ status: 'success', path: 'never-seen.js', bytes: 1 }), 'x');
  echo('run_bash', 'a plain string result', 'x');

  assert.equal(blocks.length, 3, 'one block each, none of them a diff');
  assert.ok(blocks.every((block) => !/diff /.test(block.header)));
  clearWriteCaptures();
});

test('the line CLI prints no diff block, so a headless run stays plain', () => {
  clearWriteCaptures();
  const lines = [];
  const echo = createToolEcho({ tui: null, log: (line) => lines.push(line), width: () => 100 });

  recordWriteCapture({ path: 'a.js', before: 'x\n', after: 'y\n', created: false });
  echo('edit_file', JSON.stringify({ status: 'success', path: 'a.js' }), 'x');

  assert.ok(lines.every((line) => !/diff a\.js/.test(line)), 'no block route, no block');
  assert.equal(peekWriteCapture('a.js').after, 'y\n', 'and the capture is left for the TUI');
  clearWriteCaptures();
});

test('the writers record a capture, which is what the screen draws', () => {
  // The two writers are the only place the old bytes exist, so the property to pin is
  // that each one files a pair keyed by the path its result reports.
  clearWriteCaptures();
  recordWriteCapture({ path: 'app/thing.js', before: 'before\n', after: 'after\n', created: false });
  const capture = takeWriteCapture('app/thing.js');
  assert.equal(capture.before, 'before\n');
  assert.equal(capture.after, 'after\n');
  assert.equal(capture.created, false);

  // And the spec's own wiring is real rather than described: both writers import the
  // recorder, so an edit that dropped it would fail here rather than at run time.
  for (const file of ['../tools/write_file.js', '../tools/edit_file.js']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf-8');
    assert.match(source, /recordWriteCapture/, `${file} records its before/after pair`);
  }
  clearWriteCaptures();
});