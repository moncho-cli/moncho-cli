import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createNoticeOverlay,
  formatFailureNotice,
  formatNoticeRow,
  formatNoticeRows,
  formatNoticeText,
  formatRetryNotice,
  NOTICE_COLORS,
  NOTICE_MARKERS,
  NOTICE_MAX_ROWS,
  NOTICE_TTL_MS,
} from '../app/notice-overlay.js';
import { createNoticeBar } from '../app/notice-bar.js';
import { withTui } from './support/tui-harness.js';

/**
 * Transient notices (task-backlog: "clean up failed attempts, i got a 502 error then
 * it worked but the error text was still there. this info should also be displayed in
 * some kind of overlay near the top of the screen and auto hide after some minutes").
 *
 * The bug is that a *recovered* failure was written to the transcript, where nothing
 * ever removes it. Two halves are proven here:
 *  - the model (`app/notice-overlay.js`) expires a notice on its own clock, refreshes
 *    a repeated one instead of stacking it, and can take one down by handle; and
 *  - the overlay really floats over the top of the live TUI, is hidden while there is
 *    nothing live, and a recovered failure is gone once the turn lands.
 */

const flush = async (rounds = 4) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** An injected clock, so the expiry is tested without waiting three minutes. */
function fakeClock(start = 1_000_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms) { value += ms; return value; },
  };
}

test('formatNoticeText()/formatNoticeRow() paint one sanitised, coloured line', () => {
  // one line, always: a multi-line message is flattened and truncated, never wrapped
  assert.equal(formatNoticeText('provider   down\nretrying'), 'provider down retrying');
  assert.equal(formatNoticeText('a\x1b[31mb'), 'ab', 'control characters are stripped');
  assert.equal(formatNoticeText('   \n  '), '', 'blank text is not a notice');
  assert.equal(formatNoticeText('x'.repeat(300)).length, 160);
  assert.equal(formatNoticeText('x'.repeat(300)).endsWith('…'), true);

  // the marker carries the severity even on a monochrome screen
  assert.equal(
    formatNoticeRow({ kind: 'error', text: 'HTTP error! status: 502' }),
    `{${NOTICE_COLORS.error}-fg}${NOTICE_MARKERS.error} HTTP error! status: 502{/${NOTICE_COLORS.error}-fg}`,
  );
  assert.match(formatNoticeRow({ kind: 'warn', text: 'retrying' }), /\{yellow-fg\}⚠ retrying\{\/yellow-fg\}/);
  // an unknown kind degrades to info rather than painting an undefined colour
  assert.match(formatNoticeRow({ kind: 'nonsense', text: 'x' }), /^\{grey-fg\}ℹ x\{\/grey-fg\}$/);

  // at most NOTICE_MAX_ROWS rows, oldest of the shown first, so the newest is last
  const many = [{ text: 'one' }, { text: 'two' }, { text: 'three' }, { text: 'four' }];
  const rows = formatNoticeRows(many);
  assert.equal(rows.length, NOTICE_MAX_ROWS);
  assert.match(rows.at(-1), /four/);
  assert.equal(formatNoticeRows(many, { maxRows: 0 }).length, 0);
});

test('formatRetryNotice()/formatFailureNotice() say what happened, and how it ended', () => {
  const retry = formatRetryNotice({ attempt: 1, maxRetries: 3, delayMs: 5000, error: new Error('HTTP error! status: 502') });
  assert.match(retry, /attempt 1\/3/);
  assert.match(retry, /retrying in 5s/);
  assert.match(retry, /status: 502/);

  // a failure nothing recovered from says so plainly
  assert.match(formatFailureNotice(new Error('connect ECONNREFUSED')), /Provider call failed: connect ECONNREFUSED/);
  assert.match(formatFailureNotice(undefined), /unknown error/, 'junk does not throw');
});

test('createNoticeOverlay() shows a notice and expires it on its own', () => {
  const clock = fakeClock();
  const overlay = createNoticeOverlay({ now: clock.now });

  const id = overlay.add('error', 'HTTP error! status: 502');
  assert.equal(typeof id, 'number');
  assert.equal(overlay.size, 1);
  assert.deepEqual(overlay.rows(), [`{red-fg}✖ HTTP error! status: 502{/red-fg}`]);
  // the expiry is exactly the TTL the backlog asks for ("some minutes")
  assert.equal(overlay.nextExpiry(), 1_000_000 + NOTICE_TTL_MS);

  // still there one second before it is due, gone the moment it is
  clock.advance(NOTICE_TTL_MS - 1000);
  assert.equal(overlay.size, 1);
  clock.advance(1000);
  assert.deepEqual(overlay.rows(), []);
  assert.equal(overlay.size, 0);
  assert.equal(overlay.nextExpiry(), null);

  // a blank message is not a notice at all
  assert.equal(overlay.add('info', '   '), null);
  assert.equal(overlay.size, 0);
});

test('createNoticeOverlay() refreshes a repeated notice instead of stacking it', () => {
  const clock = fakeClock();
  const overlay = createNoticeOverlay({ now: clock.now });

  const first = overlay.add('warn', 'Provider call failed (attempt 1/3, retrying in 5s): 502');
  clock.advance(4000);
  // the retry loop repeats the very same message: one row, and its TTL restarts
  const second = overlay.add('warn', 'Provider call failed (attempt 1/3, retrying in 5s): 502');

  assert.equal(second, first, 'the same news is the same notice');
  assert.equal(overlay.size, 1, 'a retry loop never stacks duplicates');
  assert.equal(overlay.nextExpiry(), clock.now() + NOTICE_TTL_MS);

  // a different message is a second row
  overlay.add('warn', 'Provider call failed (attempt 2/3, retrying in 5s): 502');
  assert.equal(overlay.size, 2);

  // and the overlay never paints more than NOTICE_MAX_ROWS of them
  overlay.add('error', 'three');
  overlay.add('info', 'four');
  assert.equal(overlay.rows().length, NOTICE_MAX_ROWS);
  assert.match(overlay.rows().at(-1), /four/);
});

test('createNoticeOverlay() caps what it keeps and can take one notice down', () => {
  const clock = fakeClock();
  const overlay = createNoticeOverlay({ now: clock.now, max: 3 });

  const first = overlay.add('info', 'one');
  overlay.add('info', 'two');
  overlay.add('info', 'three');
  overlay.add('info', 'four');

  // the oldest notice is evicted, so a long session cannot grow without bound
  assert.equal(overlay.size, 3);
  assert.deepEqual(overlay.notices.map((notice) => notice.text), ['two', 'three', 'four']);

  // a recovered failure is taken down by its handle, before its TTL is out
  assert.equal(overlay.dismiss(first), false, 'already evicted');
  const handle = overlay.add('error', 'five');
  assert.equal(overlay.dismiss(handle), true);
  assert.equal(overlay.dismiss(handle), false, 'dismissing twice is a no-op');
  assert.equal(overlay.notices.some((notice) => notice.text === 'five'), false);

  // adding 'five' evicted 'two', so two notices were left and one was dismissed
  assert.equal(overlay.clear(), 2);
  assert.equal(overlay.size, 0);
});

test('createNoticeOverlay() notifies its subscribers, and a broken one is harmless', () => {
  const clock = fakeClock();
  const overlay = createNoticeOverlay({ now: clock.now });
  const seen = [];
  const unsubscribe = overlay.subscribe((rows) => seen.push(rows.length));
  overlay.subscribe(() => { throw new Error('broken overlay'); });

  overlay.add('info', 'hello');
  assert.deepEqual(seen, [1], 'the rows are pushed to the subscriber');
  unsubscribe();
  overlay.add('info', 'again');
  assert.deepEqual(seen, [1], 'unsubscribing stops the pushes');
  overlay.close();
});

test('the overlay floats over the transcript and hides itself when empty', async () => {
  await withTui(async (tui) => {
    const widget = tui.noticeBar.widget;
    assert.ok(widget, 'the overlay box exists');
    // it floats: pinned near the top, never taking a row from the layout below
    assert.equal(widget.top, 1);
    assert.equal(widget.hidden, true, 'hidden while nothing is live');
    assert.equal(tui.notices.length, 0);
    assert.deepEqual(tui.noticeRows(), []);

    const handle = tui.notice('error', 'HTTP error! status: 502');
    await flush();
    assert.equal(widget.hidden, false);
    assert.equal(widget.height, 1);
    assert.match(widget.getContent(), /✖ HTTP error! status: 502/);
    // it is over the transcript: the transcript itself is untouched
    assert.equal(tui.transcript.getContent().includes('502'), false);

    // a second notice grows the box and the layout below it never moves
    const transcriptBottom = tui.transcript.bottom;
    tui.notice('warn', 'Provider call failed (attempt 1/3): 502');
    await flush();
    assert.equal(widget.height, 2);
    assert.equal(tui.transcript.bottom, transcriptBottom, 'the regions below never shift');

    // the handle takes the recovered failure down again
    assert.equal(tui.dismissNotice(handle), true);
    await flush();
    assert.equal(widget.height, 1);
    assert.equal(tui.notices.length, 1);

    // and with nothing left the overlay hides itself again
    tui.clearNotices();
    await flush();
    assert.equal(widget.hidden, true);
    assert.equal(widget.height, 0);
  });
});

test('a recovered 502 shows in the overlay and clears when the turn lands', async () => {
  await withTui(async (tui) => {
    // what the manager does for one retried attempt (app/conversation-manager.js)
    const retry = tui.notice('warn', formatRetryNotice({
      attempt: 1, maxRetries: 3, delayMs: 5000, error: new Error('HTTP error! status: 502'),
    }));
    await flush();

    assert.equal(tui.notices.length, 1);
    assert.match(tui.noticeBar.widget.getContent(), /attempt 1\/3/);
    // the transcript — the permanent record — was not touched
    assert.equal(tui.transcript.getContent(), '');

    // the turn finally succeeded: the notice goes away at once, not at its TTL
    assert.equal(tui.dismissNotice(retry), true);
    await flush();
    assert.equal(tui.notices.length, 0);
    assert.equal(tui.noticeBar.visible, false);
    assert.equal(tui.noticeBar.widget.hidden, true);
  });
});

test('createNoticeBar() arms one timer for the earliest expiry, not a repaint loop', () => {
  const clock = fakeClock();
  const overlay = createNoticeOverlay({ now: clock.now, ttlMs: 60_000 });
  const painted = [];
  const bar = createNoticeBar({ overlay, refresh: () => painted.push(bar.rows) });

  assert.equal(bar.visible, false);
  bar.notify('info', 'hello');
  assert.equal(bar.visible, true);
  assert.equal(bar.rows, 1);
  assert.equal(bar.timeToHide(), 60_000);

  // the timer really fires and hides the overlay on its own
  clock.advance(60_000);
  bar.paint();
  assert.equal(bar.visible, false);
  assert.equal(bar.timeToHide(), null);
  assert.deepEqual(painted, [1, 0]);

  // a closed bar leaves no timer and no subscriber behind
  bar.notify('info', 'again');
  bar.close();
  assert.equal(bar.visible, false);
});
