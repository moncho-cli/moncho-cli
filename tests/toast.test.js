import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createToast,
  formatToastText,
  savedToastText,
  SAVED_TOAST_TEXT,
  TOAST_TTL_MS,
  TOAST_MAX_CHARS,
} from '../app/toast.js';

/**
 * The copy confirmation model (`docs/interface/clipboard-selection`): one plain sentence,
 * four seconds. The sentence names the file the selection was saved to, because that name
 * is the reader's next step.
 */

/** A clock the test drives by hand. */
function fakeClock() {
  let now = 1_000_000;
  return {
    now: () => now,
    advance: (ms) => { now += ms; },
  };
}

test('the copy toast says the plain sentence and lives for four seconds', () => {
  const clock = fakeClock();
  const toast = createToast({ now: clock.now });

  assert.equal(TOAST_TTL_MS, 4000, 'four seconds is the lifetime');
  assert.equal(TOAST_MAX_CHARS, 60, 'the box is 60 characters wide');
  assert.equal(SAVED_TOAST_TEXT, 'Saved data to');

  const shown = toast.show('Saved data to .moncho.clipboard.093015');
  assert.equal(shown, 'Saved data to .moncho.clipboard.093015');
  assert.equal(toast.current, shown);
  assert.equal(toast.visible, true);
  assert.equal(toast.nextExpiry(), clock.now() + TOAST_TTL_MS);

  clock.advance(TOAST_TTL_MS - 1);
  assert.equal(toast.visible, true, 'still up just before its time');
  clock.advance(1);
  assert.equal(toast.current, '', 'gone exactly on time');
  assert.equal(toast.visible, false);
});

test('the sentence names the file the selection was saved to', () => {
  // The name is the whole point: it tells the reader what to open.
  assert.equal(savedToastText('.moncho.clipboard.101010'), 'Saved data to .moncho.clipboard.101010');
  // A copy without a name still says something honest rather than throwing.
  assert.equal(savedToastText(''), 'Saved data to a clipboard file');
  assert.equal(savedToastText(null), 'Saved data to a clipboard file');
  assert.equal(savedToastText(undefined), 'Saved data to a clipboard file');
  // The sentence begins with the constant, so the wording is one decision.
  assert.ok(savedToastText('.moncho.clipboard.000000').startsWith(SAVED_TOAST_TEXT));
});

test('a second copy replaces the first and restarts its four seconds', () => {
  const clock = fakeClock();
  const toast = createToast({ now: clock.now });

  toast.show('Saved data to .moncho.clipboard.090000');
  clock.advance(3000);
  toast.show('Saved data to .moncho.clipboard.090001');

  assert.equal(toast.current, 'Saved data to .moncho.clipboard.090001', 'the newest copy is what is shown');
  assert.equal(toast.nextExpiry(), clock.now() + TOAST_TTL_MS, 'the clock restarted');
});

test('a blank message is not a toast, and a long one is fitted to the box', () => {
  const toast = createToast({ now: fakeClock().now });
  assert.equal(toast.show(''), null);
  assert.equal(toast.show('   '), null);
  assert.equal(toast.visible, false);

  const long = 'Saved data to ' + 'x'.repeat(100);
  const shown = toast.show(long);
  assert.ok(shown.length <= TOAST_MAX_CHARS, 'the sentence is cut to the box');
  assert.ok(shown.endsWith('…'), 'the cut is marked');
  assert.equal(formatToastText('a\nb'), 'a b', 'a newline is flattened');
});

test('subscribe() reports the sentence, and close() stops the reports', () => {
  const toast = createToast({ now: fakeClock().now });
  const seen = [];
  const unsubscribe = toast.subscribe((text) => seen.push(text));

  toast.show('Saved data to .moncho.clipboard.120000');
  assert.deepEqual(seen, ['Saved data to .moncho.clipboard.120000']);

  unsubscribe();
  toast.show('Saved data to .moncho.clipboard.120001');
  assert.equal(seen.length, 1, 'an unsubscribed listener hears nothing');
  toast.close();
});
