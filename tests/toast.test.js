import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createToast,
  formatToastText,
  COPIED_TOAST_TEXT,
  TOAST_TTL_MS,
  TOAST_MAX_CHARS,
} from '../app/toast.js';

/**
 * The copy confirmation model (`docs/interface/clipboard-selection`): one plain sentence,
 * four seconds, gone again. The clock is injected, so none of this waits.
 */

/** A clock that only moves when told to. */
function fakeClock(start = 1_000_000) {
  let at = start;
  return {
    now: () => at,
    advance: (ms) => { at += ms; },
  };
}

test('the copy toast says the plain sentence and lives for four seconds', () => {
  const clock = fakeClock();
  const toast = createToast({ now: clock.now });

  assert.equal(TOAST_TTL_MS, 4000, 'the lifetime is the four seconds that were asked for');
  assert.equal(COPIED_TOAST_TEXT, 'Copied text to clipboard', 'no character count, just the sentence');

  assert.equal(toast.visible, false, 'nothing is up until something happens');

  const shown = toast.show(COPIED_TOAST_TEXT);
  assert.equal(shown, COPIED_TOAST_TEXT);
  assert.equal(toast.current, COPIED_TOAST_TEXT);
  assert.equal(toast.visible, true);
  assert.equal(toast.timeToHide === undefined, true, 'the bar owns the countdown, the model the expiry');
  assert.equal(toast.nextExpiry(), clock.now() + TOAST_TTL_MS);

  // One millisecond short of the deadline it is still there; at it, it is gone.
  clock.advance(TOAST_TTL_MS - 1);
  assert.equal(toast.visible, true, 'still up just before its time');
  clock.advance(1);
  assert.equal(toast.current, '', 'gone exactly on time');
  assert.equal(toast.visible, false);
  assert.equal(toast.nextExpiry(), null);
});

test('a second copy replaces the first and restarts its four seconds', () => {
  const clock = fakeClock();
  const toast = createToast({ now: clock.now });

  toast.show(COPIED_TOAST_TEXT);
  clock.advance(3000);

  toast.show(COPIED_TOAST_TEXT);
  clock.advance(3000);
  assert.equal(toast.visible, true, 'the countdown restarted from the latest copy');
  assert.equal(toast.nextExpiry(), clock.now() + 1000);
});

test('a blank message is not a toast, and the text is fitted to the box', () => {
  const toast = createToast({ now: fakeClock().now });

  assert.equal(toast.show('   '), null, 'whitespace is not news');
  assert.equal(toast.show(null), null);
  assert.equal(toast.visible, false);

  assert.equal(formatToastText('  Copied   text  '), 'Copied text', 'flattened to one line');
  const long = formatToastText('x'.repeat(TOAST_MAX_CHARS + 20));
  assert.equal([...long].length, TOAST_MAX_CHARS, 'cut to the box width');
  assert.match(long, /…$/, 'the cut is marked');
  // The cut is between clusters, so a box never shows half an emoji.
  const emoji = formatToastText('👍🏽'.repeat(TOAST_MAX_CHARS));
  assert.doesNotMatch(emoji, /[\uD800-\uDBFF]$/);
});

test('subscribe() reports every change, and close() forgets the subscribers', () => {
  const clock = fakeClock();
  const toast = createToast({ now: clock.now });
  const seen = [];
  const unsubscribe = toast.subscribe((message) => seen.push(message));

  toast.show(COPIED_TOAST_TEXT);
  assert.deepEqual(seen, [COPIED_TOAST_TEXT]);

  toast.hide();
  assert.deepEqual(seen, [COPIED_TOAST_TEXT, ''], 'hiding is a change too');

  unsubscribe();
  toast.show(COPIED_TOAST_TEXT);
  assert.equal(seen.length, 2, 'an unsubscribed listener hears nothing');

  // A throwing listener cannot take the model down with it.
  toast.subscribe(() => { throw new Error('boom'); });
  assert.doesNotThrow(() => toast.show(COPIED_TOAST_TEXT));

  toast.close();
  assert.equal(toast.visible, false);
});