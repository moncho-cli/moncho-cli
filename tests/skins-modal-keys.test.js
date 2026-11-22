import test from 'node:test';
import assert from 'node:assert/strict';

import { openSkinModal } from '../app/skin-modal.js';
import { availableActions, moveIndex, clampIndex, decideKey } from '../app/skin-actions.js';
import { withTui } from './support/tui-harness.js';

/**
 * `/skins prompt` (`docs/interface/skins`), the **modal keyboard** half: how an arrow key
 * moves the action cursor, and how the cursor is kept on a row the list still offers.
 *
 * The confirm flow itself (the proposal, the name field, the action list) lives in
 * `tests/skins-modal.test.js`; the proposal and its validation in
 * `tests/skins-prompt.test.js`.
 */

const flush = () => new Promise((resolve) => setImmediate(resolve));
function press(tui, name, extra = {}) {
  tui.screen.program.emit('keypress', null, { name, full: name, ...extra });
}

test('the arrow keys move the action cursor from the name field, and take the focus with them', () => {
  // The defect this pins: the modal puts the focus in the name field the moment the
  // proposal lands, and there an arrow answered `none` — so reaching for the arrows did
  // nothing until Tab had moved the focus to the list. An arrow now moves the cursor and
  // the focus together, which is what "arrow navigation" means in a picker.
  for (const name of ['up', 'down']) {
    assert.equal(decideKey({ key: { name }, focus: 'name', ready: true }).type, 'move');
  }
  // In the actions, `j`/`k` stay a second spelling of the arrows…
  assert.equal(decideKey({ key: { name: 'j' }, focus: 'actions', ready: true }).delta, 1);
  // …but in the name field they are letters a name may contain, never a command.
  assert.equal(decideKey({ key: { name: 'j', full: 'j' }, focus: 'name', ready: true }).type, 'edit');
  assert.equal(decideKey({ key: { name: 'k', full: 'k' }, focus: 'name', ready: true }).type, 'edit');
});

test('openSkinModal() moves the cursor and the focus on an arrow, so Enter applies what is highlighted', async () => {
  await withTui(async (tui) => {
    const answer = openSkinModal({
      screen: tui.screen,
      proposer: async () => ({ name: 'sunset', palette: { intent: 'bright-yellow' } }),
      request: 'a warm sunset',
      refresh: tui.refresh,
    });
    await flush();

    const box = tui.screen.children.at(-1);
    assert.equal(box.state().focus, 'name', 'the field has the focus when the proposal lands');

    // The marker is painted as a colour, so the frame is read with its escapes stripped:
    // what matters is the row the user sees marked, not the cursor number behind it.
    const marked = () => box.getContent()
      .replace(/\x1b\[[\d;]*m/g, '')
      .split('\n')
      .filter((line) => line.startsWith('>'))
      .join(' | ');
    assert.match(marked(), /Apply for this session/, 'the first action is marked before the arrow');

    press(tui, 'down');
    assert.equal(box.state().focus, 'actions', 'the arrow takes the focus to the list');
    assert.equal(box.state().index, 1, 'and moves the cursor onto the second action');
    assert.match(marked(), /Apply and save/, 'the painted marker moved with it');
    assert.doesNotMatch(marked(), /Apply for this session/, 'and the first row is no longer marked');
    press(tui, 'down');
    assert.equal(box.state().index, 2, 'a second arrow keeps moving it');
    assert.match(marked(), /Cancel/, 'the marker reached the last action');
    press(tui, 'up');
    assert.equal(box.state().index, 1, 'and the other direction comes back');
    assert.match(marked(), /Apply and save/, 'the marker followed the cursor back');

    // Enter now applies the highlighted action instead of moving the focus again.
    press(tui, 'enter');
    const choice = await answer;
    assert.deepEqual(choice, { skin: { name: 'sunset', palette: { intent: 'bright-yellow' } }, save: true });
  });
});

test('the cursor is clamped to the actions offered, so a shrinking list never loses the highlight', async () => {
  // The defect this pins: emptying the name drops the apply actions, but the cursor was
  // left pointing past the end of the shortened list, so no row was painted as selected.
  assert.equal(clampIndex(2, 3), 2);
  assert.equal(clampIndex(2, 1), 0, 'a cursor past the end settles on the last action offered');
  assert.equal(clampIndex(5, 0), 0, 'and an empty list answers the first position');
  // The two halves of the cursor agree with the size of the list they are given.
  for (const ready of [false, true]) {
    const list = availableActions({ ready });
    for (let delta = -3; delta <= 3; delta += 1) {
      assert.ok(clampIndex(moveIndex(0, delta, list.length), list.length) < list.length);
    }
  }

  await withTui(async (tui) => {
    const answer = openSkinModal({
      screen: tui.screen,
      proposer: async () => ({ name: 'sunset', palette: { intent: 'bright-yellow' } }),
      request: 'a warm sunset',
      refresh: tui.refresh,
    });
    await flush();

    const box = tui.screen.children.at(-1);
    press(tui, 'enter'); // name -> actions
    press(tui, 'down');
    press(tui, 'down');
    assert.equal(box.state().index, 2, 'the cursor reached Cancel');

    press(tui, 'tab'); // back to the name
    for (let i = 0; i < 'sunset'.length; i += 1) press(tui, 'backspace');
    await flush();
    assert.deepEqual(box.state().actions, ['cancel'], 'the apply actions are off the list');
    assert.equal(box.state().index, 0, 'and the cursor settled onto the one action left');

    press(tui, 'enter'); // name -> actions
    press(tui, 'enter'); // the only action is Cancel
    assert.equal(await answer, null);
  });
});
