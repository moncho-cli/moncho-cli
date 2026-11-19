import test from 'node:test';
import assert from 'node:assert/strict';

import { createResizeRepaint, createTeardown } from '../app/tui-teardown.js';

/**
 * The TUI's two one-way edges: the resize repaint and the teardown.
 *
 * Both are sequences of calls over the regions `createTui()` built, so they are
 * proven here with plain spies instead of a pty: what matters is *what* is called,
 * *in which order*, and that a second close is harmless.
 */

/** A region stub that records its own name into a shared call log. */
function region(name, methods, calls, extra = {}) {
  const entry = { name };
  for (const method of methods) {
    entry[method] = () => calls.push(`${name}.${method}`);
  }
  return { ...entry, ...extra };
}

test('createResizeRepaint() re-fits every row measured at the old width', () => {
  const calls = [];
  const screen = { on: (event, listener) => calls.push(`${event}:${typeof listener}`) };
  const regions = {
    screen,
    transcript: region('transcript', ['setScrollPerc'], calls),
    statusRow: region('statusRow', ['render'], calls),
    queue: region('queue', ['paint'], calls),
    brandBar: region('brandBar', ['paint'], calls),
    noticeBar: region('noticeBar', ['paint'], calls),
  };

  const repaint = createResizeRepaint(regions);

  assert.deepEqual(calls, ['resize:function'], 'the listener is bound to the resize event');
  calls.length = 0;

  repaint();

  assert.deepEqual(calls, [
    'transcript.setScrollPerc',
    'statusRow.render',
    'queue.paint',
    'brandBar.paint',
    'noticeBar.paint',
  ], 'the newest line is kept in view and every width-fitted row is re-fitted');
});

test('createResizeRepaint() survives a half-built screen', () => {
  assert.doesNotThrow(() => createResizeRepaint()());
  assert.doesNotThrow(() => createResizeRepaint({ screen: {} })());
});

test('createTeardown() closes in construction-reverse order and only once', () => {
  const calls = [];
  const screen = { destroy: () => calls.push('screen.destroy') };
  let closed = false;

  const close = createTeardown({
    steps: [() => calls.push('input'), () => calls.push('queue'), () => calls.push('view')],
    screen,
    state: { isClosed: () => closed, markClosed: () => { closed = true; } },
  });

  close();
  assert.deepEqual(calls, ['input', 'queue', 'view', 'screen.destroy']);

  close();
  assert.deepEqual(calls, ['input', 'queue', 'view', 'screen.destroy'], 'a second close is a no-op');
});

test('createTeardown() without a latch still tears down, and skips unknown steps', () => {
  const calls = [];
  const close = createTeardown({
    steps: [() => calls.push('one'), null, 'not-a-function'],
    screen: { destroy: () => calls.push('screen') },
  });

  close();

  assert.deepEqual(calls, ['one', 'screen']);
});