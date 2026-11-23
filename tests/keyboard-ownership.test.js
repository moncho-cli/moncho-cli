import test from 'node:test';
import assert from 'node:assert/strict';

import {
  claimKeyboard,
  releaseKeyboard,
  unlockMouse,
  keyboardHeld,
} from '../app/keyboard-ownership.js';

/**
 * The keyboard lock and the mouse it was silently taking with it
 * (`docs/interface/clipboard-selection`).
 *
 * `screen.lockKeys` is one switch over two input channels — blessed's key dispatcher and
 * its mouse dispatcher both return early on it — so a modal that claimed the keyboard also
 * stopped every mouse report reaching any widget. That is what made the read-only viewer
 * uncopyable. These cases pin the narrow fix: the key lock still holds, and the mouse can
 * be handed back without giving up the claim.
 */

/** A screen stub with only the two facts the ledger reads. */
const fakeScreen = () => ({ lockKeys: false, on() {}, removeListener() {} });

test('a keyboard lease sets the lock, and releasing it restores the lock before it', () => {
  const screen = fakeScreen();
  const lease = claimKeyboard({ screen });
  assert.equal(screen.lockKeys, true);
  assert.equal(keyboardHeld(), true);

  releaseKeyboard(lease);
  assert.equal(screen.lockKeys, false, 'the lock it carried before is handed back');
  assert.equal(keyboardHeld(), false);
});

test('unlockMouse() clears the lock while the keyboard lease still stands', () => {
  const screen = fakeScreen();
  const lease = claimKeyboard({ screen });
  assert.equal(screen.lockKeys, true);

  assert.equal(unlockMouse({ screen }), true, 'the mouse is given back');
  assert.equal(screen.lockKeys, false, 'blessed no longer skips its mouse dispatch');
  assert.equal(keyboardHeld(), true, 'and the keyboard is still claimed');

  // Idempotent: a second ask is a no-op rather than a second change.
  assert.equal(unlockMouse({ screen }), false);

  releaseKeyboard(lease);
  assert.equal(screen.lockKeys, false);
});

test('unlockMouse() refuses a screen nobody has claimed, and a missing one', () => {
  const free = fakeScreen();
  assert.equal(unlockMouse({ screen: free }), false, 'no lease, nothing to relax');
  assert.equal(free.lockKeys, false, 'and it never raises the lock it was asked to clear');
  assert.equal(unlockMouse({ screen: null }), false);
  assert.equal(unlockMouse(), false);
});

test('unlockMouse() is scoped to the screen it is asked about', () => {
  const claimed = fakeScreen();
  const other = fakeScreen();
  other.lockKeys = true;
  const lease = claimKeyboard({ screen: claimed });

  assert.equal(unlockMouse({ screen: other }), false, 'no lease on that screen');
  assert.equal(other.lockKeys, true, 'so its lock is untouched');

  releaseKeyboard(lease);
});