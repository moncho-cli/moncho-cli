import test from 'node:test';
import assert from 'node:assert/strict';

import { openSkinModal } from '../app/skin-modal.js';
import { withTui } from './support/tui-harness.js';

/**
 * `/skins prompt` (`docs/interface/skins`), proven the way the user sees it: through
 * **real input bytes** and the **rendered screen cells**.
 *
 * Every other suite in this area drives the widget with a synthetic
 * `program.emit('keypress', …)`, which proves the *handler* but not the *wiring*: a
 * byte that the terminal sends is decoded by neo-blessed, re-emitted on the program
 * and only then reaches a listener. A modal whose listener is attached to the wrong
 * place passes a synthetic test and is dead in the program — which is what the report
 * was ("the arrow navigation does not really work").
 *
 * So these cases write the **bytes** a terminal sends and read the **cells** the
 * terminal would show:
 *
 *  - `\x1b[B` is the down arrow, `\x1b[A` the up arrow, `\r` Enter, `\t` Tab,
 *    `\x1b` Escape — exactly what a terminal puts on the wire;
 *  - the screen is read back as plain text with the escapes resolved, so the assertion
 *    is on what a user would read, not on the index behind it.
 */

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * The rows of the **rendered screen**, read off blessed's own cell grid.
 *
 * The grid is what the terminal was sent: `screen.lines[y][x]` is one cell, its
 * attribute and its character. Reading it is reading the screen the way a user reads
 * it — not the byte stream that got there, and not the widget's own content, which
 * may say more than the screen shows.
 *
 * @param {object} screen the blessed screen
 * @returns {string[]} the rows, one string per line
 */
function screenRows(screen) {
  return (screen.lines || []).map((line) => line.map((cell) => cell[1]).join('').trimEnd());
}

/** The rows that hold the modal's actions. */
const actionRows = (rows) => rows.filter((row) => /Apply for this session|Apply and save|Cancel/.test(row));

test('real arrow bytes move the cursor, and the marked row on the screen moves with it', async () => {
  // The defect this pins: the arrows were answered by the handler but the modal could
  // be driven by a synthetic event only — and the marker on the screen did not always
  // follow the cursor behind it.
  await withTui(async (tui, { input, painted }) => {
    const answer = openSkinModal({
      screen: tui.screen,
      proposer: async () => ({ name: 'sunset', palette: { intent: 'bright-yellow' } }),
      request: 'a warm sunset',
      refresh: tui.refresh,
    });
    await flush();
    await flush();

    // The real down-arrow bytes, twice.
    input.write('\x1b[B');
    await flush();
    input.write('\x1b[B');
    await flush();

    const box = tui.screen.children.at(-1);
    assert.equal(box.state().focus, 'actions', 'the arrow took the focus to the list');
    assert.equal(box.state().index, 2, 'and moved the cursor onto the last action');

    // The marker is painted as a colour, so the frame is read with its escapes gone:
    // what matters is the row the user sees marked.
    const marked = () => box.getContent()
      .replace(/\x1b\[[\d;]*m/g, '')
      .split('\n')
      .filter((line) => line.startsWith('>'))
      .join(' | ');
    assert.match(marked(), /Cancel/, 'the marked row is Cancel');
    assert.doesNotMatch(marked(), /Apply for this session/, 'and the first row is no longer marked');

    // The real up-arrow bytes bring it back.
    input.write('\x1b[A');
    await flush();
    assert.equal(box.state().index, 1, 'the cursor came back');
    assert.match(marked(), /Apply and save/, 'and the marker followed it');

    // The real Enter byte applies what is highlighted.
    input.write('\r');
    await flush();
    const choice = await answer;
    assert.equal(choice.save, true, 'the highlighted action was the one that was applied');
    assert.equal(choice.skin.name, 'sunset');
    void painted;
  });
});

test('the actions are on the rendered screen, and the terminal never saw them clipped', async () => {
  // The defect this pins: the action list was pushed off the bottom of the box and
  // clipped by blessed, so the user was shown a modal with no way to answer it. The
  // assertion is on the **cells**: the actions are in the grid the terminal received.
  await withTui(async (tui, { input }) => {
    const answer = openSkinModal({
      screen: tui.screen,
      proposer: async () => ({
        name: 'sunset',
        palette: {
          user: 'bright-cyan', tool: 'yellow', intent: 'bright-blue', context: 'magenta',
          error: 'red', notice: 'grey', tracking: 'bright-green', refusal: 'bright-red',
        },
      }),
      request: 'a warm sunset for every kind of row',
      refresh: tui.refresh,
    });
    await flush();
    await flush();
    tui.refresh();
    await flush();

    const rows = screenRows(tui.screen);
    const actions = actionRows(rows);
    assert.ok(actions.length >= 3, `the actions are on the screen: ${JSON.stringify(actions)}`);
    assert.ok(
      actions.some((row) => row.includes('Apply for this session')),
      'the first action is on the screen',
    );
    assert.ok(actions.some((row) => row.includes('Cancel')), 'Cancel is on the screen');

    // The real Escape byte cancels it, and the host does not hear the key.
    input.write('\x1b');
    await flush();
    assert.equal(await answer, null);
  });
});

test('a real Escape byte cancels the modal without interrupting the turn', async () => {
  // The defect this pins: the modal locked blessed's own dispatch, but the host's
  // program-level listener answered the same Escape — so cancelling the modal also
  // aborted the running turn.
  let interrupts = 0;
  await withTui(async (tui, { input }) => {
    const answer = openSkinModal({
      screen: tui.screen,
      proposer: async () => ({ name: 'sunset', palette: { intent: 'bright-yellow' } }),
      request: 'a warm sunset',
      refresh: tui.refresh,
    });
    await flush();
    await flush();

    input.write('\x1b');
    await flush();
    assert.equal(await answer, null, 'the modal was cancelled');
    assert.equal(interrupts, 0, 'and the turn was not aborted');
  }, { onInterrupt: () => { interrupts += 1; } });
});

test('a real Tab byte moves the modal focus and does not cycle the session mode', async () => {
  // The defect this pins: Tab was answered by the modal *and* by the host, so the
  // session mode changed underneath a modal the user was still reading.
  let cycles = 0;
  await withTui(async (tui, { input }) => {
    const answer = openSkinModal({
      screen: tui.screen,
      proposer: async () => ({ name: 'sunset', palette: { intent: 'bright-yellow' } }),
      request: 'a warm sunset',
      refresh: tui.refresh,
    });
    await flush();
    await flush();

    const box = tui.screen.children.at(-1);
    assert.equal(box.state().focus, 'name', 'the name field has the focus');

    input.write('\t');
    await flush();
    assert.equal(box.state().focus, 'actions', 'Tab moved the modal focus');
    assert.equal(cycles, 0, 'and the session mode did not move');

    input.write('\x1b');
    await flush();
    assert.equal(await answer, null);
  }, { onCycleMode: () => { cycles += 1; } });
});

test('the real typed characters land in the name field, once each', async () => {
  // The keyboard contract end to end: the bytes a user types reach the field, and
  // they reach it exactly once.
  await withTui(async (tui, { input }) => {
    const answer = openSkinModal({
      screen: tui.screen,
      proposer: async () => ({ name: 'sunset', palette: { intent: 'bright-yellow' } }),
      request: 'a warm sunset',
      refresh: tui.refresh,
    });
    await flush();
    await flush();

    const box = tui.screen.children.at(-1);
    for (const character of 'ab') input.write(character);
    await flush();
    assert.equal(box.name(), 'sunsetab', 'the characters were appended once each');

    input.write('\x1b');
    await flush();
    assert.equal(await answer, null);
  });
});
