import test from 'node:test';
import assert from 'node:assert/strict';

import { createTui } from '../app/tui.js';
import { fakeTty, plainText, withTui, visible } from './support/tui-harness.js';

/**
 * The TUI screen wiring: the regions, the scroll bindings, the question surface
 * and the transcript echoes. The pure text helpers (sanitising, markdown, paste
 * collapsing, tool delimiters) live in tests/tui-render.test.js, the status row in
 * tests/tui-status.test.js and the pending-message queue in
 * tests/message-queue.test.js.
 */

test('a pty gets the three-region TUI (transcript, status bar, input box)', async () => {
  await withTui((tui, { painted }) => {
    assert.ok(tui, 'expected a TUI when output.isTTY is true');

    // transcript: bordered, scrollable, pinned above the status bar
    assert.equal(tui.transcript.bottom, 5);
    // ...and starting one row down: row 0 is the brand line, so the conversation's
    // own border is the row below the mark (see tests/brand.test.js).
    assert.equal(tui.transcript.top, 1);
    assert.equal(tui.transcript.scrollable, true);

    // status bar: exactly one row, directly under the transcript
    assert.equal(tui.statusBar.height, 1);
    assert.equal(tui.statusBar.bottom, 3);
    assert.equal(tui.statusBar.getContent(), 'Ready');

    // model label: one row between the status bar and the input box
    assert.equal(tui.modelBar.height, 1);
    assert.equal(tui.modelBar.bottom, 4);
    assert.equal(tui.modelBar.getContent(), tui.modelLabel);
    assert.equal(tui.modelLabel, 'openrouter · test/model');

    // input box: three rows (border + content + border) at the very bottom
    assert.equal(tui.inputBox.height, 3);
    assert.equal(tui.inputBox.bottom, 0);

    // the queue region sits right above the input box and costs no row while empty
    assert.equal(tui.queueBar.bottom, 3);
    assert.equal(tui.queueBar.height, 0);
    assert.equal(tui.queueBar.hidden, true);
    assert.equal(tui.queueHeight, 0);
    assert.equal(tui.queuedCount, 0);

    // the initial paint really reached the terminal
    assert.match(painted(), /Conversation/);
    assert.match(painted(), /Ready/);
    assert.match(plainText(painted()), /openrouter · test\/model/);
  });
});

test('the queue bar shifts the regions above it up by its height', async () => {
  await withTui((tui) => {
    // setQueueHeight() is the layout contract the queue bar paints through: the
    // status bar, the model row and the transcript move up, the input box does not.
    assert.equal(tui.setQueueHeight(2), 2);
    assert.equal(tui.queueBar.height, 2);
    assert.equal(tui.queueBar.hidden, false);
    assert.equal(tui.statusBar.bottom, 5);
    assert.equal(tui.modelBar.bottom, 6);
    assert.equal(tui.transcript.bottom, 7);
    assert.equal(tui.inputBox.bottom, 0);

    // 0 hides the region again and restores every anchor
    assert.equal(tui.setQueueHeight(0), 0);
    assert.equal(tui.queueBar.height, 0);
    assert.equal(tui.queueBar.hidden, true);
    assert.equal(tui.statusBar.bottom, 3);
    assert.equal(tui.modelBar.bottom, 4);
    assert.equal(tui.transcript.bottom, 5);

    // junk is treated as "no rows", never as a crash
    assert.equal(tui.setQueueHeight(-5), 0);
    assert.equal(tui.setQueueHeight(undefined), 0);
  });
});

test('the transcript scrolls, including from the keyboard', async () => {
  await withTui((tui) => {
    for (let i = 0; i < 200; i += 1) tui.log(`line ${i}`);
    assert.ok(tui.transcript.getScrollHeight() > 0, 'expected scrollable content');

    tui.transcript.setScrollPerc(100);
    const bottom = tui.transcript.getScroll();
    assert.ok(bottom > 0, 'expected to be scrolled down after 200 lines');

    tui.scrollBy(-1);
    const afterScrollUp = tui.transcript.getScroll();
    assert.ok(afterScrollUp < bottom, `scrollBy(-1) should move up (${bottom} -> ${afterScrollUp})`);

    tui.scrollBy(1);
    assert.ok(tui.transcript.getScroll() > afterScrollUp, 'scrollBy(1) should move back down');

    // pageup/pagedown are bound on the screen so they work while the input has focus
    tui.screen.emit('keypress', null, { name: 'pageup', full: 'pageup' });
    assert.ok(tui.transcript.getScroll() < bottom, 'pageup should scroll the transcript up');

    tui.screen.emit('keypress', null, { name: 'home', full: 'home' });
    assert.equal(tui.transcript.getScroll(), 0, 'home should jump to the top');

    tui.screen.emit('keypress', null, { name: 'end', full: 'end' });
    assert.equal(tui.transcript.getScrollPerc(), 100, 'end should jump to the bottom');
  });
});

test('a mid-session resize keeps the layout and repaints', async () => {
  await withTui((tui, { output, chunks }) => {
    tui.log('before resize');
    const before = chunks.length;

    output.columns = 100;
    output.rows = 30;
    output.emit('resize');

    assert.equal(tui.screen.width, 100);
    assert.equal(tui.screen.height, 30);
    // relative layout => the regions keep their anchors
    assert.equal(tui.transcript.bottom, 5);
    assert.equal(tui.statusBar.bottom, 3);
    assert.equal(tui.modelBar.bottom, 4);
    assert.equal(tui.inputBox.bottom, 0);
    assert.equal(tui.queueBar.bottom, 3);
    assert.ok(before >= 0);
  });
});

test('log() sanitizes model output and keeps one line per row', async () => {
  await withTui((tui) => {
    tui.log('\x1b[31mred\x1b[0m\nsecond line');
    const text = visible(tui);
    assert.match(text, /red/);
    assert.doesNotMatch(text, /\x1b\[31m/);
    assert.match(text, /second line/);
  });
});

test('question() resolves through the input box, like createCLI().rl.question', async () => {
  await withTui(async (tui) => {
    const answered = tui.question('> ');
    assert.equal(tui.inputBox.getLabel(), ' > ');

    tui.inputBox.setValue('hello');
    tui.inputBox.emit('submit', 'hello');
    assert.equal(await answered, 'hello');

    // callback style is supported too (AbortManager calls rl.question(prompt, cb))
    const viaCallback = new Promise((resolve) => {
      tui.rl.question('Cancel this task? [y/N] ', resolve);
    });
    tui.inputBox.emit('submit', 'y');
    assert.equal(await viaCallback, 'y');
  });
});

test('without a pty createTui() returns null so the line chat is kept', () => {
  const input = fakeTty({ isTTY: false });
  const output = fakeTty({ isTTY: false });
  try {
    assert.equal(createTui({ input, output }), null);
  } finally {
    input.destroy();
    output.destroy();
  }
});

test('the tool-call intent is echoed to the transcript, ahead of the result', async () => {
  await withTui(async (tui, { painted }) => {
    // main.js renders every tool result as:
    //   \n  [<tool> Output] (intent: <phrase>)\n<result>\n
    tui.log('\n  [read_file Output] (intent: why the file is read)');
    tui.log('file body');
    await new Promise((resolve) => setImmediate(resolve));

    // the intent survives into the transcript text ...
    const content = visible(tui);
    assert.match(content, /\[read_file Output\] \(intent: why the file is read\)/);
    // ... it is printed above the result payload ...
    assert.ok(
      content.indexOf('(intent: why the file is read)') < content.indexOf('file body'),
      'expected the intent line above the tool result',
    );
    // ... and it really reached the terminal frame
    assert.match(plainText(painted()), /\(intent: why the file is read\)/);
  });
});

test('notifyCompaction() marks a compaction in the transcript, once per event', async () => {
  await withTui(async (tui, { painted }) => {
    // ConversationManager hands onContextChange the stats() snapshot from
    // app/context-window.js: a running compaction count plus the last report.
    const stats = {
      chunks: 5,
      compactions: 1,
      usage: '7.4k / 8.0k tokens (92%)',
      lastCompaction: {
        at: 1700000000000,
        reason: 'over budget',
        olderChunks: 4,
        keptChunks: 1,
        olderTokens: 7200,
        afterTokens: 1800,
      },
    };

    tui.notifyCompaction(stats);
    // neo-blessed writes asynchronously; flush the repaint before reading the frame.
    await new Promise((resolve) => setImmediate(resolve));
    const content = visible(tui);
    assert.match(content, /\[Context\] compaction fired/);
    assert.match(content, /4 older chunk\(s\) -> summary, kept 1 newest chunk\(s\)/);
    assert.match(content, /\(7200 -> 1800 tokens\)/);
    // the marker really reached the terminal frame, not only the buffer
    assert.match(plainText(painted()), /\[Context\] compaction fired/);

    // onContextChange fires on every chunk: the same report must not repeat
    tui.notifyCompaction(stats);
    tui.notifyCompaction({ ...stats });
    assert.equal(
      visible(tui).split('[Context] compaction fired').length - 1,
      1,
      'an unchanged compaction count must not mark the transcript again',
    );

    // a genuinely new compaction (count 2) does mark again
    tui.notifyCompaction({
      ...stats,
      compactions: 2,
      lastCompaction: { ...stats.lastCompaction, olderChunks: 3, keptChunks: 2 },
    });
    assert.equal(visible(tui).split('[Context] compaction fired').length - 1, 2);
  });
});
