import test from 'node:test';
import assert from 'node:assert/strict';

import { withTui } from './support/tui-harness.js';
import { displayWidth } from '../app/queue-rows.js';
import { createBusyCommandRunner } from '../app/busy-command.js';
import { createDefaultCommands } from '../app/commands.js';

/**
 * The queue bar on screen: the region right above the input box, the
 * queue-while-in-flight rule and the deletion by click. The model, the rows and
 * the injection rule are pure and proven in tests/message-queue.test.js and
 * tests/queue-rows.test.js; here they are driven through the real `createTui()` on
 * the shared fake TTY.
 */

/** Flush neo-blessed's deferred repaints (it writes from setImmediate). */
const flush = async (rounds = 4) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** The screen row of one painted queue row: widget origin plus border/padding. */
const queueRowScreenRow = (tui, index) => tui.queueBar.lpos.yi + tui.queueBar.itop + index;

/** Click a queue row, exactly as neo-blessed would deliver it. */
const clickQueueRow = (tui, index) =>
  tui.clickQueue({ x: tui.queueBar.lpos.xi + 2, y: queueRowScreenRow(tui, index) });

/**
 * Type `text` into the box and press Enter, exactly as a terminal does.
 *
 * `value` is assigned rather than `setValue()`d on purpose: a textbox strips the
 * newlines of a paste for *display*, while neo-blessed's own key listener appends
 * the raw chunk, newlines included, to `value`. Assigning reproduces that, and
 * `submit()` then ends the read cycle through the same `_done` path as Enter. The
 * flush first is deliberate too: the read listener is attached from a deferred
 * tick, so the keystroke only reaches it once that tick has run.
 */
const typeAndEnter = async (tui, text) => {
  await flush();
  tui.inputBox.value = text;
  tui.inputBox.submit();
  await flush();
};

test('a submission while a request is in flight is queued, and shown above the input box', async () => {
  await withTui(async (tui) => {
    // the loop asks for a prompt, the user answers, and the turn starts
    const armed = tui.question('> ');
    await typeAndEnter(tui, 'first turn');
    assert.equal(await armed, 'first turn');

    assert.equal(tui.queuedCount, 0, 'nothing is queued while the box is idle');
    assert.equal(tui.queueHeight, 0);
    assert.equal(tui.queueBar.hidden, true, 'an empty queue costs no row');

    tui.startSpinner();
    // ... and the box is armed *while the turn runs*, which is the whole point:
    // Enter now queues instead of resolving a question nobody armed.
    await typeAndEnter(tui, 'second thought');

    assert.equal(tui.queuedCount, 1);
    assert.deepEqual(tui.queued.map((item) => item.text), ['second thought']);
    assert.match(tui.queueBar.getContent(), /✕ 1\. second thought/);
    assert.equal(tui.queueBar.hidden, false);

    // the queue sits right above the input box: every region above it shifted up
    assert.equal(tui.queueBar.bottom, 3);
    assert.equal(tui.queueBar.height, 1);
    assert.equal(tui.inputBox.bottom, 0, 'the input box never moves');
    assert.equal(tui.statusBar.bottom, 4, 'the status bar moved up by the queue height');
    assert.equal(tui.workBar.bottom, 5);
    assert.equal(tui.modelBar.bottom, 6);
    assert.equal(tui.transcript.bottom, 7);
  });
});

test('the box stays armed after a queued submission, so the next keystroke lands', async () => {
  await withTui(async (tui) => {
    tui.startSpinner();
    await flush();
    assert.equal(tui.inputBox._reading, true, 'the box is armed while the turn runs');

    // Enter ends neo-blessed's read cycle, so the box has to be armed again:
    // otherwise the rest of a long turn would silently lose every keystroke.
    await typeAndEnter(tui, 'one');
    assert.equal(tui.queuedCount, 1);
    assert.equal(tui.inputBox._reading, true, 'the box keeps reading after a queued submit');
    assert.equal(tui.inputBox.listeners('keypress').length, 1, 'exactly one read listener');

    // one keystroke appends one character — never two
    tui.inputBox.emit('keypress', 't', { name: 't', full: 't' });
    assert.equal(tui.inputBox.getValue(), 't');

    await typeAndEnter(tui, 'two');
    assert.deepEqual(tui.queued.map((item) => item.text), ['one', 'two']);
  });
});

test('the queued text is verbatim, and the queue drains in order between turns', async () => {
  await withTui(async (tui) => {
    const pasted = 'line 1\nline 2\nline 3\nline 4\nline 5';
    tui.startSpinner();
    await typeAndEnter(tui, pasted);
    await typeAndEnter(tui, 'plain second');

    assert.equal(tui.queuedCount, 2);
    // the collapsed paste tag is expanded again, so the bytes are the bytes typed
    assert.equal(tui.queued[0].text, pasted);
    assert.match(tui.queueBar.getContent(), /✕ 1\. line 1 line 2 line 3/);

    tui.stopSpinner();
    // the host loop drains the queue between turns: FIFO, verbatim
    assert.equal(tui.dequeue(), pasted);
    assert.equal(tui.dequeue(), 'plain second');
    await flush();
    assert.equal(tui.dequeue(), null, 'an empty queue yields nothing to inject');
    assert.equal(tui.queuedCount, 0);
    assert.equal(tui.queueHeight, 0, 'the region shrinks back when the queue empties');
    assert.equal(tui.queueBar.hidden, true);
    assert.equal(tui.statusBar.bottom, 3, 'the anchors above it are restored');
    assert.equal(tui.transcript.bottom, 6);
  });
});

test('a click on a ✕ row deletes that message only, and the region shrinks back', async () => {
  await withTui(async (tui) => {
    tui.startSpinner();
    for (const text of ['one', 'two', 'three']) await typeAndEnter(tui, text);

    assert.equal(tui.queueHeight, 3);
    assert.match(tui.queueBar.getContent(), /✕ 1\. one/);
    assert.match(tui.queueBar.getContent(), /✕ 3\. three/);

    // the middle row: only that message goes, and the rest keep their order
    const removed = clickQueueRow(tui, 1);
    await flush();
    assert.equal(removed.text, 'two');
    assert.deepEqual(tui.queued.map((item) => item.text), ['one', 'three']);
    assert.equal(tui.queueHeight, 2);
    assert.match(tui.queueBar.getContent(), /✕ 1\. one\n✕ 2\. three/);
    assert.equal(tui.statusBar.bottom, 5);

    // a click above the first message row deletes nothing
    assert.equal(tui.clickQueue({ x: tui.queueBar.lpos.xi + 2, y: tui.queueBar.lpos.yi - 1 }), null);
    assert.equal(tui.queuedCount, 2);

    clickQueueRow(tui, 0);
    clickQueueRow(tui, 0);
    await flush();
    assert.equal(tui.queuedCount, 0, 'deleting every row empties the queue');
    assert.equal(tui.queueBar.hidden, true);
    assert.equal(tui.statusBar.bottom, 3);
  });
});

test('a message typed while idle is not queued: the box settles the armed question', async () => {
  await withTui(async (tui) => {
    const armed = tui.question('> ');
    await typeAndEnter(tui, 'idle message');

    assert.equal(await armed, 'idle message', 'the idle submission answers the question');
    assert.equal(tui.queuedCount, 0, 'and nothing is queued behind its back');
    assert.equal(tui.queueBar.hidden, true);
  });
});

test('a long queued message uses the whole bar and is never wrapped or clipped', async () => {
  await withTui(async (tui, { output }) => {
    tui.startSpinner();
    // A message far longer than the old fixed 48-character preview.
    await typeAndEnter(tui, 'readable '.repeat(20).trim());

    // The bar reports the interior width it really has — the screen less its own two
    // columns of padding — and the row spends the whole of it.
    assert.equal(tui.queueColumns, 78, 'an 80-column screen leaves a 78-cell interior');
    assert.equal(displayWidth(tui.queueRows()[0]), 78);
    assert.ok(tui.queueRows()[0].endsWith('…'), 'the truncation is visible');

    // One message, one display line: the region is exactly as tall as what it holds,
    // so nothing below the last row can be clipped away.
    assert.equal(tui.queueBar.getScreenLines().length, 1);
    assert.equal(tui.queueBar.height, 1);

    // A resize re-fits every row: the preview would otherwise keep the width of the
    // terminal it was painted in.
    output.columns = 40;
    output.emit('resize');
    await flush();
    assert.equal(tui.queueColumns, 38);
    assert.equal(displayWidth(tui.queueRows()[0]), 38);
    assert.equal(tui.queueBar.getScreenLines().length, 1, 'still one row, never wrapped');
    assert.equal(tui.queueBar.height, 1);
  });
});

test('a slash command submitted mid-turn is answered, never queued', async () => {
  await withTui(async (tui) => {
    // The host's mid-turn handler (`docs/interface/busy-commands`): a read-only command is
    // consumed and run now, a mutating one is refused, a prompt is handed back.
    const seen = [];
    const notices = [];
    tui.setBusySubmit(createBusyCommandRunner({
      registry: createDefaultCommands(),
      run: (input) => { seen.push(input); return Promise.resolve(); },
      notify: (kind, text) => notices.push({ kind, text }),
    }));

    tui.startSpinner();
    // A read-only command: answered at once, so the queue stays empty.
    await typeAndEnter(tui, '/help');
    assert.equal(tui.queuedCount, 0, 'a command is not a message for the model');
    assert.equal(tui.queueBar.hidden, true);
    assert.deepEqual(seen, ['/help'], 'and it really ran, in parallel with the turn');

    // A command that would rewrite the live window is refused instead of queued.
    await typeAndEnter(tui, '/new');
    assert.equal(tui.queuedCount, 0);
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /cannot run while a turn is in progress/);

    // A prompt is still a prompt: it waits in the queue as it always did.
    await typeAndEnter(tui, 'steer the work');
    assert.equal(tui.queuedCount, 1);
    assert.deepEqual(tui.queued.map((item) => item.text), ['steer the work']);

    // And the box is still in its read cycle after each of those: mid-turn there is no
    // armed *question* (the loop is busy in processInput), only the capturing box.
    assert.equal(tui.promptInput.isReading, true);
  });
});
