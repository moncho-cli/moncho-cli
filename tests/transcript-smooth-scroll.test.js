import test from 'node:test';
import assert from 'node:assert/strict';

import { pageStepRows, WHEEL_STEP_ROWS } from '../app/transcript-view.js';
import { withTui, visible } from './support/tui-harness.js';

/**
 * Scrolling through the conversation (task-backlog: "conversation scrolling is
 * not smooth").
 *
 * Two halves, both proven here:
 *  - the *steps* are pure arithmetic (`pageStepRows`, `WHEEL_STEP_ROWS`), and
 *  - the *view* moves by whole rows: a wheel notch over the transcript nudges it,
 *    page-up/page-down move a screenful, both clamp at the ends, and a scroll
 *    only moves the viewport instead of rebuilding the whole content (which is
 *    what made every step stutter).
 *
 * The wheel cases drive the real `createTui()` on the shared fake TTY and dispatch
 * the mouse event exactly as blessed does (`screen.program.emit('mouse', …)`), so
 * the binding is verified against what ships rather than a stub.
 */

/** Flush neo-blessed's deferred repaints (it writes from setImmediate). */
const flush = async (rounds = 4) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A transcript long enough to scroll, parked at the bottom. */
const fillAndPark = async (tui, lines = 200) => {
  for (let i = 0; i < lines; i += 1) tui.log(`line ${i}`);
  await flush();
  tui.transcript.setScrollPerc(100);
  await flush();
};

/** Rows of content visible at once, straight from the widget's geometry. */
const visibleRows = (tui) => tui.transcript.height - tui.transcript.iheight;

const wheel = (tui, action) => tui.screen.program.emit('mouse', { action, x: 10, y: 5 });
const key = (tui, name) => tui.screen.emit('keypress', null, { name, full: name });

test('pageStepRows() steps one row short of a screenful, and never zero', () => {
  assert.equal(pageStepRows(17), 16, 'a page overlaps the previous one by a row');
  assert.equal(pageStepRows(2), 1);
  assert.equal(pageStepRows(1), 1, 'a one-row viewport still steps a row');
  assert.equal(pageStepRows(0), 1, 'an unmeasured widget steps a row rather than none');
  assert.equal(pageStepRows(), 1, 'no argument at all is still a usable step');
  assert.equal(pageStepRows(Number.NaN), 1, 'junk geometry is not a crash');
  assert.ok(pageStepRows(40) < 40, 'the step is never a whole screenful');
});

test('a wheel notch over the transcript nudges it a few rows', async () => {
  await withTui(async (tui) => {
    await fillAndPark(tui);
    const bottom = tui.transcript.childBase;
    assert.ok(bottom > 0, 'expected a scrolled transcript');

    wheel(tui, 'wheelup');
    await flush();
    assert.equal(
      tui.transcript.childBase,
      bottom - WHEEL_STEP_ROWS,
      'a notch moves exactly WHEEL_STEP_ROWS rows up',
    );

    wheel(tui, 'wheeldown');
    await flush();
    assert.equal(tui.transcript.childBase, bottom, 'the opposite notch comes back');
    assert.ok(WHEEL_STEP_ROWS > 1, 'a notch is more than a single row');
  });
});

test('page-up and page-down move a whole screenful and clamp at the ends', async () => {
  await withTui(async (tui) => {
    await fillAndPark(tui);
    const step = pageStepRows(visibleRows(tui));
    const bottom = tui.transcript.childBase;

    key(tui, 'pageup');
    await flush();
    assert.equal(tui.transcript.childBase, bottom - step, 'a page is a screenful minus one row');

    key(tui, 'pagedown');
    await flush();
    assert.equal(tui.transcript.childBase, bottom, 'paging down returns to the bottom');

    // At the very bottom a further page down must not scroll past the content.
    key(tui, 'pagedown');
    await flush();
    assert.equal(tui.transcript.childBase, bottom, 'the bottom is a hard limit');

    // ... and at the very top a page up must not go negative.
    key(tui, 'home');
    await flush();
    assert.equal(tui.transcript.childBase, 0);
    key(tui, 'pageup');
    await flush();
    assert.equal(tui.transcript.childBase, 0, 'the top is a hard limit');
    wheel(tui, 'wheelup');
    await flush();
    assert.equal(tui.transcript.childBase, 0, 'a wheel notch clamps at the top too');
  });
});

test('a scroll moves the viewport without rebuilding the transcript content', async () => {
  await withTui(async (tui) => {
    await fillAndPark(tui);

    // Every step used to re-set the whole content (setContent re-wraps all lines),
    // which is what made a page or a wheel notch feel like a stutter.
    const original = tui.transcript.setContent;
    let rebuilds = 0;
    tui.transcript.setContent = (...args) => {
      rebuilds += 1;
      return original.apply(tui.transcript, args);
    };

    key(tui, 'pageup');
    wheel(tui, 'wheelup');
    key(tui, 'pagedown');
    await flush();

    tui.transcript.setContent = original;
    assert.equal(rebuilds, 0, 'scrolling must not re-set the content');
    assert.match(visible(tui), /line 199/, 'the content is still there');
  });
});

test('scrolling keeps the follow/hold rule intact', async () => {
  await withTui(async (tui) => {
    await fillAndPark(tui);

    // A wheel notch away from the bottom is "reading history": the next message
    // must not drag the view back down.
    wheel(tui, 'wheelup');
    await flush();
    const held = tui.transcript.childBase;
    assert.ok(tui.transcript.getScrollPerc() < 100, 'expected to be reading history');

    tui.log('a message arrives while the reader scrolled up');
    await flush();
    assert.equal(tui.transcript.childBase, held, 'the reader keeps the offset they chose');

    // Paging back to the end resumes following.
    key(tui, 'end');
    await flush();
    assert.equal(tui.transcript.getScrollPerc(), 100);
    tui.log('newest line');
    await flush();
    assert.match(visible(tui), /newest line/);
  });
});
