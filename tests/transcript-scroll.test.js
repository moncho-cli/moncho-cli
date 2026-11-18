import test from 'node:test';
import assert from 'node:assert/strict';

import { createTranscriptView, isFollowingScroll } from '../app/transcript-view.js';
import { withTui, visible } from './support/tui-harness.js';

/**
 * An arriving message must not drag the transcript to the bottom
 * (task-backlog: "conversation jumps to the bottom when a message arrives, it
 * should not").
 *
 * The rule has two halves and both are proven here:
 *  - the *decision* is pure arithmetic (`isFollowingScroll`), and
 *  - the *view* acts on it in `paint()`: a reader who scrolled up keeps their
 *    offset, a reader parked at the bottom keeps following, and the block-toggle
 *    hold (`keepScroll: true`) is unchanged.
 *
 * The first half is driven with a stub widget (no terminal), the second half
 * through the real `createTui()` on the shared fake TTY, so the fix is verified
 * against what actually ships.
 */

/** Flush neo-blessed's deferred repaints (it writes from setImmediate). */
const flush = async (rounds = 4) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('isFollowingScroll() follows at the bottom and holds above it', () => {
  const geometry = { scrollHeight: 200, visibleHeight: 17 };

  assert.equal(isFollowingScroll({ ...geometry, percent: 100 }), true, 'the very end follows');
  assert.equal(isFollowingScroll({ ...geometry, percent: 99.5 }), true, 'the tolerance covers rounding');
  assert.equal(isFollowingScroll({ ...geometry, percent: 99 }), false, 'one row up is not the bottom');
  assert.equal(isFollowingScroll({ ...geometry, percent: 94 }), false, 'reading history holds');
  assert.equal(isFollowingScroll({ ...geometry, percent: 0 }), false, 'the top holds too');

  // junk is treated as "not at the bottom", never as a crash
  assert.equal(isFollowingScroll({ ...geometry, percent: Number.NaN }), false);
  assert.equal(isFollowingScroll({ percent: undefined }), true, 'no geometry yet means nothing to hold');
});

test('isFollowingScroll() follows when there is nothing to scroll yet', () => {
  // content that already fits: a growing short transcript must still follow
  assert.equal(isFollowingScroll({ percent: 0, scrollHeight: 5, visibleHeight: 17 }), true);
  assert.equal(isFollowingScroll({ percent: 0, scrollHeight: 17, visibleHeight: 17 }), true);
  // an unmeasured widget (no layout yet) has no offset worth holding
  assert.equal(isFollowingScroll({ percent: 0, scrollHeight: 200, visibleHeight: 0 }), true);
  assert.equal(isFollowingScroll(), true);
});

/**
 * A minimal stand-in for the blessed log widget: content whose line count drives
 * the geometry, a clamped offset, and the same methods the view reads. Lets the
 * view be driven with no terminal at all.
 */
function stubWidget({ height = 19, inner = 2 } = {}) {
  const visible = height - inner;
  const state = { content: '', offset: 0 };

  const lines = () => (state.content ? state.content.split('\n').length : 0);
  const maxOffset = () => Math.max(0, lines() - visible);

  return {
    height,
    iheight: inner,
    lpos: { xi: 0, yi: 0 },
    _userScrolled: false,
    setContent(text) {
      state.content = String(text ?? '');
      state.offset = Math.min(maxOffset(), Math.max(0, state.offset));
    },
    getContent() { return state.content; },
    getScroll() { return state.offset; },
    getScrollHeight() { return lines(); },
    getScrollPerc() { return maxOffset() === 0 ? 0 : (state.offset / maxOffset()) * 100; },
    setScroll(offset) { state.offset = Math.min(maxOffset(), Math.max(0, offset)); },
    setScrollPerc(percent) { state.offset = Math.round((percent / 100) * maxOffset()); },
    max() { return maxOffset(); },
  };
}

test('the transcript view holds the reader offset when a message arrives', async () => {
  const widget = stubWidget();
  const view = createTranscriptView({ widget });

  for (let i = 0; i < 200; i += 1) view.log(`line ${i}`);
  await flush();

  widget.setScroll(widget.max() - 20);
  const held = widget.getScroll();
  assert.ok(held > 0 && widget.getScrollPerc() < 100, 'expected to be reading history');

  view.log('a message arrives while the reader is scrolled up');
  await flush();

  assert.equal(widget.getScroll(), held, 'the reader keeps the offset they chose');
  assert.match(view.content, /a message arrives/);
  assert.equal(view.isFollowing(), false);
});

test('the transcript view follows new output while parked at the bottom', async () => {
  const widget = stubWidget();
  const view = createTranscriptView({ widget });

  assert.equal(view.isFollowing(), true, 'a fresh transcript follows');

  for (let i = 0; i < 200; i += 1) view.log(`line ${i}`);
  await flush();
  assert.equal(widget.getScroll(), widget.max(), 'the view is parked at the bottom');
  assert.equal(widget.getScrollPerc(), 100);

  // the reader scrolls up, then comes back to the end: following resumes
  widget.setScroll(120);
  view.log('scrolled up');
  await flush();
  assert.equal(widget.getScroll(), 120, 'the reader offset survives the append');

  widget.setScrollPerc(100);
  view.log('back at the bottom');
  await flush();
  assert.equal(widget.getScrollPerc(), 100, 'following resumed once the reader returned');
  assert.equal(widget.getScroll(), widget.max());
});

test('keepScroll: true forces the hold even when parked at the bottom', async () => {
  const widget = stubWidget();
  const view = createTranscriptView({ widget });

  for (let i = 0; i < 20; i += 1) view.log(`line ${i}`);
  const block = view.logBlock({ header: '  [tool Output]', body: 'a\nb\nc' });
  await flush();

  widget.setScrollPerc(100);
  const before = widget.getScroll();

  // a toggle always holds, whatever the follow rule would have said
  view.expandBlock(block.id);
  await flush();
  assert.equal(widget.getScroll(), before, 'expanding keeps the offset by contract');
  assert.equal(widget._userScrolled, true, 'the widget auto-jump stays suppressed');

  view.collapseBlock(block.id);
  await flush();
  assert.equal(widget.getScroll(), before, 'collapsing keeps it too, even though the content shrank');
});

test('an arriving message does not jump the transcript while the reader is scrolled up', async () => {
  await withTui(async (tui) => {
    for (let i = 0; i < 200; i += 1) tui.log(`line ${i}`);
    await flush();

    // the reader pages up, exactly as the transcript key bindings do
    tui.screen.emit('keypress', null, { name: 'pageup', full: 'pageup' });
    await flush();
    const before = tui.transcript.getScroll();
    assert.ok(before > 0 && tui.transcript.getScrollPerc() < 100, 'expected to be reading history');

    // a message arrives: the offset must survive it
    tui.log('--- assistant reply arrives ---');
    tui.log('second line of the reply');
    await flush();

    assert.equal(tui.transcript.getScroll(), before, 'the view must not jump to the bottom');
    assert.match(visible(tui), /assistant reply arrives/);
    assert.ok(
      tui.transcript.getScrollPerc() < 100,
      'the percentage drops because the content grew, but the view did not move',
    );

    // ... and the reader can still scroll from there
    tui.screen.emit('keypress', null, { name: 'pageup', full: 'pageup' });
    await flush();
    assert.ok(tui.transcript.getScroll() < before, 'keyboard scrolling still works after the hold');
  });
});

test('an arriving message at the bottom still scrolls the newest line into view', async () => {
  await withTui(async (tui) => {
    for (let i = 0; i < 200; i += 1) tui.log(`line ${i}`);
    await flush();

    tui.transcript.setScrollPerc(100);
    await flush();
    const before = tui.transcript.getScroll();
    assert.equal(tui.transcript.getScrollPerc(), 100);

    tui.log('newest arriving line');
    await flush();

    assert.ok(tui.transcript.getScroll() > before, 'the view followed the new line');
    assert.equal(tui.transcript.getScrollPerc(), 100, 'still parked at the bottom');
    assert.match(visible(tui), /newest arriving line/);
  });
});

test('a fresh short transcript keeps following as it grows', async () => {
  await withTui(async (tui) => {
    tui.log('hello');
    await flush();
    // Nothing to scroll yet, so blessed reports 0%: the follow rule must not read
    // that as "the reader scrolled up".
    assert.match(visible(tui), /hello/);

    for (let i = 0; i < 30; i += 1) tui.log(`line ${i}`);
    await flush();
    assert.equal(tui.transcript.getScrollPerc(), 100, 'following survived the growth');
    assert.match(visible(tui), /line 29/);
  });
});
