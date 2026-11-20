import test from 'node:test';
import assert from 'node:assert/strict';

import {
  displayWidth,
  graphemes,
  graphemeWidth,
  truncateToWidth,
  cutCodePoints,
  tailWithin,
} from '../app/cell-width.js';

/**
 * Width is counted in display cells, not code points (docs/interface/prompt-editor).
 *
 * The unit of text is the **grapheme cluster**: an emoji sequence is one glyph of two
 * cells, a combining accent is one glyph of one cell, and a zero-width mark costs
 * nothing. This is what makes a fitted row still fit, and a truncated line end on a
 * whole character instead of half a surrogate pair.
 */

test('graphemes() and displayWidth() count cells per cluster, not per code point', () => {
  assert.deepEqual(graphemes('ab'), ['a', 'b']);
  assert.deepEqual(graphemes(''), []);

  // An emoji sequence is ONE cluster, and a terminal paints it two cells wide — the
  // bug the old per-code-point rule had was charging `👍🏽` three.
  assert.equal(graphemes('👍🏽').length, 1);
  assert.equal(displayWidth('👍🏽'), 2);
  assert.equal(displayWidth('😀'), 2);
  assert.equal(displayWidth('👨‍👩‍👧'), 2);
  // `❤️` is a text glyph plus the selector that makes it emoji: one glyph, two cells.
  assert.equal(graphemes('❤️').length, 1);
  assert.equal(displayWidth('❤️'), 2);
  // A combining accent is part of its base character and adds no cell.
  assert.equal(graphemes('e\u0301').length, 1);
  assert.equal(displayWidth('e\u0301'), 1);
  // CJK is still double, plain text still one, and an empty string zero.
  assert.equal(displayWidth('漢'), 2);
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth(null), 0);
  assert.equal(graphemeWidth(''), 0);
});

test('truncateToWidth() and cutCodePoints() never cut a character in half', () => {
  // The ellipsis is charged to the budget, so the result never exceeds it.
  assert.equal(truncateToWidth('abcdef', 4), 'abc…');
  assert.ok(displayWidth(truncateToWidth('😀😀😀😀', 5)) <= 5);
  assert.equal(truncateToWidth('😀😀😀', 5), '😀😀…');
  assert.equal(truncateToWidth('short', 40), 'short');
  // A truncated emoji line ends on a whole glyph, never on half a surrogate pair.
  const cut = truncateToWidth(`${'👍🏽'.repeat(30)}`, 9);
  assert.equal(displayWidth(cut), 9);
  assert.equal(cut.endsWith('…'), true);
  assert.equal([...cut].join('').includes('\ud83d\udc4d'), true);

  assert.equal(cutCodePoints('abcdef', 4), 'abc…');
  assert.equal(cutCodePoints('ab', 4), 'ab');
  assert.equal(cutCodePoints('👍🏽👍🏽👍🏽', 2), '👍🏽…');
  assert.equal(cutCodePoints('anything', 0), '');
});

test('tailWithin() keeps the cells that end at the caret, and nothing before them', () => {
  assert.deepEqual(tailWithin('abc', 10), { text: 'abc', cells: 3 });
  assert.deepEqual(tailWithin('abcdef', 3), { text: 'def', cells: 3 });
  assert.deepEqual(tailWithin('a😀b', 3), { text: '😀b', cells: 3 });
  assert.deepEqual(tailWithin('abc', 0), { text: '', cells: 0 });
});
