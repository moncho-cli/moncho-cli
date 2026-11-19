import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isEscapeKey,
  isCtrlC,
  isInterruptKey,
  isTabKey,
  isShiftTabKey,
  ESCAPE_CHAR,
  CTRL_C_CHAR,
  TAB_CHAR,
} from '../utils/keys.js';

/**
 * The key-shape predicates (docs/interface/interrupt-controls).
 *
 * The same physical key arrives in a different shape depending on who decoded it,
 * so these are the one place that decides what a key *is*: readline reports
 * `{ sequence, name, ctrl }`, blessed reports `{ full, name, ctrl }`, and Escape
 * arrives with no byte at all in the second case.
 *
 * Split out of `tests/interrupt-controls.test.js` (which owns the AbortManager and
 * the two front ends) to keep both suites under the line budget; the behaviour
 * proven is the same contract.
 */

/** The shapes the two decoders produce, and the raw bytes they share. */
const READLINE_ESCAPE = ['\x1b', { sequence: '\x1b', name: 'escape' }];
const READLINE_CTRL_C = ['\x03', { sequence: '\x03', name: 'c', ctrl: true }];
const BLESSED_ESCAPE = [null, { full: 'escape', name: 'escape' }];
const BLESSED_CTRL_C = ['\x03', { full: 'C-c', name: 'c', ctrl: true }];
const BLESSED_TAB = ['\x09', { full: 'tab', name: 'tab' }];
const BLESSED_SHIFT_TAB = [null, { full: 'S-tab', name: 'tab', shift: true }];

test('the key-shape constants name the bytes the decoders deliver', () => {
  assert.equal(ESCAPE_CHAR, '\x1b');
  assert.equal(CTRL_C_CHAR, '\x03');
  assert.equal(TAB_CHAR, '\x09');
});

test('isInterruptKey recognises Escape/Ctrl+C in both decoder shapes', () => {
  for (const [ch, key] of [READLINE_ESCAPE, BLESSED_ESCAPE]) {
    assert.equal(isEscapeKey(ch, key), true);
    assert.equal(isInterruptKey(ch, key), true);
    assert.equal(isCtrlC(ch, key), false);
  }
  for (const [ch, key] of [READLINE_CTRL_C, BLESSED_CTRL_C]) {
    assert.equal(isCtrlC(ch, key), true);
    assert.equal(isInterruptKey(ch, key), true);
    assert.equal(isEscapeKey(ch, key), false);
  }

  // Ordinary typing and unrelated keys must never look like an interrupt.
  assert.equal(isInterruptKey('a', { name: 'a' }), false);
  assert.equal(isInterruptKey('\r', { name: 'enter' }), false);
  assert.equal(isInterruptKey(null, { name: 'pageup', full: 'pageup' }), false);
  assert.equal(isInterruptKey(undefined, undefined), false);
  assert.equal(isInterruptKey('\x03', {}), true, 'the raw byte is enough');
});

test('isTabKey recognises Tab and Shift+Tab without swallowing an interrupt', () => {
  // Tab arrives as the raw byte, as blessed's name, or as Shift+Tab's own sequence.
  assert.equal(isTabKey('\x09', { name: 'tab', full: 'tab' }), true);
  assert.equal(isTabKey(null, { name: 'tab', full: 'tab' }), true);
  assert.equal(isTabKey('\x09', {}), true, 'the raw byte is enough');
  assert.equal(isTabKey(...BLESSED_TAB), true);
  assert.equal(isTabKey(...BLESSED_SHIFT_TAB), true, 'Shift+Tab is still Tab');

  // Shift+Tab is told apart from Tab, so a binding can cycle the other way.
  assert.equal(isShiftTabKey(...BLESSED_SHIFT_TAB), true);
  assert.equal(isShiftTabKey(...BLESSED_TAB), false);
  assert.equal(isShiftTabKey('\x09', { name: 'tab', full: 'tab' }), false);

  // Nothing else looks like Tab: typing, Enter, the interrupt pair, and junk.
  for (const [ch, key] of [['a', { name: 'a' }], ['\r', { name: 'enter' }],
    READLINE_ESCAPE, BLESSED_ESCAPE, READLINE_CTRL_C, BLESSED_CTRL_C]) {
    assert.equal(isTabKey(ch, key), false);
  }
  assert.equal(isTabKey(undefined, undefined), false);
  assert.equal(isShiftTabKey(undefined, undefined), false);

  // The two families are disjoint: Tab is never an interrupt and vice versa.
  assert.equal(isInterruptKey(...BLESSED_TAB), false);
  assert.equal(isTabKey(...BLESSED_ESCAPE), false);
});
