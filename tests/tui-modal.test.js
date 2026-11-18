import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseLabel } from '../app/tui-modal.js';
import { withTui } from './support/tui-harness.js';

/** Emit a key exactly as neo-blessed's program would. */
function press(tui, name, extra = {}) {
  tui.screen.program.emit('keypress', null, { name, full: name, ...extra });
}

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
