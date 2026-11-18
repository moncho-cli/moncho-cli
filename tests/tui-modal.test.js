import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseLabel } from '../app/tui-modal.js';
import { withTui } from './support/tui-harness.js';

/** Emit a key exactly as neo-blessed's program would. */
function press(tui, name, extra = {}) {
  tui.screen.program.emit('keypress', null, { name, full: name, ...extra });
}

/**
 * One turn of the event loop: neo-blessed arms the input box's read listener and
 * flushes its paints from deferred ticks, so a byte written too early is lost.
 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('the picker modal opens, navigates and resolves with the chosen index', async () => {
  await withTui(async (tui) => {
    const labels = ['first session', 'second session', 'third session'];
    let opened = null;
    const answer = chooseLabel({
      screen: tui.screen,
      labels,
      title: 'Sessions',
      render: tui.refresh,
      onOpenChange: (open) => {
        opened = open;
      },
    });

    assert.equal(opened, true, 'the modal announces that it opened');
    assert.equal(tui.screen.lockKeys, true, 'the modal owns the keyboard while open');

    press(tui, 'down');
    press(tui, 'down');
    press(tui, 'up');
    press(tui, 'enter');

    assert.equal(await answer, 1, 'the highlighted row is returned by index');
    assert.equal(opened, false, 'closing is announced too');
    assert.notEqual(tui.screen.lockKeys, true, 'the screen lock is restored');
  });
});

test('the modal cancels with Escape and with Ctrl+C, returning null', async () => {
  await withTui(async (tui) => {
    const escape = chooseLabel({ screen: tui.screen, labels: ['a', 'b'], render: tui.refresh });
    press(tui, 'escape');
    assert.equal(await escape, null);

    const ctrlC = chooseLabel({ screen: tui.screen, labels: ['a', 'b'], render: tui.refresh });
    press(tui, 'c', { ctrl: true });
    assert.equal(await ctrlC, null);
  });
});

test('the modal wraps at the ends and jumps with home/end', async () => {
  await withTui(async (tui) => {
    const labels = ['a', 'b', 'c'];
    const answer = chooseLabel({ screen: tui.screen, labels, render: tui.refresh });

    press(tui, 'up'); // wraps to the last row
    press(tui, 'enter');
    assert.equal(await answer, 2);

    const second = chooseLabel({ screen: tui.screen, labels, render: tui.refresh });
    press(tui, 'end');
    press(tui, 'down'); // wraps back to the first row
    press(tui, 'enter');
    assert.equal(await second, 0);
  });
});

test('a picker with no rows cancels instead of resolving nonsense', async () => {
  await withTui(async (tui) => {
    const answer = chooseLabel({ screen: tui.screen, labels: [], render: tui.refresh });
    press(tui, 'enter'); // nothing is highlighted, so nothing can be chosen
    assert.equal(await answer, null);
    assert.notEqual(tui.screen.lockKeys, true);
  });
});

test('closing the picker modal leaves the input box reading a keystroke once', async () => {
  await withTui(async (tui, { input }) => {
    // Round 1: the host arms a prompt and the user submits /sessions, exactly as
    // the loop in main.js does before the command opens the modal.
    const first = tui.question('> ');
    await flush();
    input.write('/sessions');
    await flush();
    input.write('\r');
    assert.equal(await first, '/sessions');

    // The command opens the picker; the user cancels it with Escape. The host
    // then arms the next prompt straight away, in the same turn, as main.js does.
    const modal = tui.choose(['first session', 'second session'], { title: 'Sessions' });
    await flush();
    press(tui, 'escape');
    assert.equal(await modal, null);

    // Round 2: one keypress must produce exactly one character. Closing the modal
    // focuses the box while it is still unwinding the old read; a second read
    // cycle would leave two 'keypress' listeners on the box and every keystroke
    // would be appended twice -- the "/sessions breaks the input" bug.
    const second = tui.question('> ');
    await flush();
    input.write('a');
    await flush();
    assert.equal(tui.inputBox.getValue(), 'a', 'one keystroke must land exactly once');

    input.write('b');
    await flush();
    assert.equal(tui.inputBox.getValue(), 'ab', 'and the next one too');

    tui.inputBox.emit('submit', tui.inputBox.getValue());
    assert.equal(await second, 'ab');
  });
});
