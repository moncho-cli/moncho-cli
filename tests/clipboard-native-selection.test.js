import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { nativeSelectionEnabled } from '../config/constants.js';
import { withTui } from './support/tui-harness.js';

/**
 * `NATIVE_SELECTION_ENABLED`: the terminal's own selection, **opt-in**
 * (`docs/interface/clipboard-selection`).
 *
 * The two selections are mutually exclusive on a bare drag, because blessed enables mouse
 * reporting the moment a mouse listener is bound. So this is not "our gesture is off" but "the
 * protocol is never negotiated", and the assertion is on **what was written to the terminal** —
 * the thing the terminal actually obeys.
 *
 * The default is the in-app path, because every mouse interaction in this program is built on
 * the reports the flag gives up: the wheel, the click-to-expand block and the click that
 * removes a message from the queue. Taking the mouse away is therefore a deliberate trade, and
 * a reader makes it explicitly.
 *
 * The flag is read late (`nativeSelectionEnabled()`), so a case can flip it in the process
 * environment; each one restores the previous value, so the order cases run in cannot change a
 * result.
 */

const DECSET = (mode) => `\x1b[?${mode}h`;

/** Run `fn` with the variable set to `value` (`null` = unset), restoring what was there. */
function withEnv(value, fn) {
  const before = process.env.NATIVE_SELECTION_ENABLED;
  if (value === null) delete process.env.NATIVE_SELECTION_ENABLED;
  else process.env.NATIVE_SELECTION_ENABLED = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.NATIVE_SELECTION_ENABLED;
    else process.env.NATIVE_SELECTION_ENABLED = before;
  }
}

const flush = async (rounds = 4) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('nativeSelectionEnabled() is off by default, and an explicit yes turns it on', () => {
  // Off unless it says yes. Unset and blank both mean "this program owns the mouse", so a typo
  // cannot silently take the wheel and the clicks away from the reader.
  assert.equal(withEnv(null, () => nativeSelectionEnabled()), false, 'unset keeps the mouse');
  assert.equal(withEnv('', () => nativeSelectionEnabled()), false, 'blank keeps the mouse');
  assert.equal(withEnv('0', () => nativeSelectionEnabled()), false, '0 keeps the mouse');
  assert.equal(withEnv('no', () => nativeSelectionEnabled()), false, 'no keeps the mouse');
  assert.equal(withEnv('nonsense', () => nativeSelectionEnabled()), false, 'an unknown value keeps the mouse');

  // On only on an explicit yes, which is the reader handing the mouse to the terminal.
  for (const yes of ['1', 'true', 'on', 'yes', 'y', ' ON ']) {
    assert.equal(withEnv(yes, () => nativeSelectionEnabled()), true, `${JSON.stringify(yes)} hands it over`);
  }
});

test('by default the app asks for the mouse, so its own interactions work', async () => {
  await withTui(async (tui, { chunks }) => {
    tui.log('alpha bravo charlie');
    await flush();
    tui.screen.render();

    // The protocol is negotiated and the in-app path is installed: this is what makes the
    // wheel, the block click and the queue click work.
    assert.equal(chunks.join('').includes(DECSET(1006)), true, 'SGR was requested');
    assert.equal(tui.screen.program.mouseEnabled, true, 'mouse tracking is on');
    assert.notEqual(tui.selectionRange, undefined, 'the in-app selection is installed');
  }, { columns: 80, rows: 24, nativeSelection: false });
});

test('opted in, the app never asks for the mouse and the terminal keeps it', async () => {
  await withTui(async (tui, { chunks }) => {
    // Enough activity that every path which could arm the dispatcher has run.
    tui.log('alpha bravo charlie');
    tui.logBlock({ header: 'read_file Output', body: 'body text' });
    await flush();
    tui.screen.render();

    const out = chunks.join('');
    for (const mode of ['1000', '1002', '1003', '1005', '1006']) {
      assert.equal(out.includes(DECSET(mode)), false, `?${mode} was not requested`);
    }
    // `setMouse()` is the only writer of `mouseEnabled`, and it never ran: the property is
    // absent rather than false, which is exactly the proof that nothing was negotiated.
    assert.ok(!tui.screen.program.mouseEnabled, 'no mouse tracking was enabled');

    // And the in-app selection is not installed, so nothing answers a report either.
    assert.equal(tui.selectionRange, null, 'no selection exists');
  }, { columns: 80, rows: 24, nativeSelection: true });
});

test('opted in, a drag belongs to the terminal, so this program saves nothing', async () => {
  await withTui(async (tui, { clipboardDir }) => {
    const widget = tui.transcript;
    const x = widget.lpos.xi + widget.ileft;
    const y = widget.lpos.yi + widget.itop;

    // A report the terminal would never send — but if anything were listening, it would copy.
    tui.screen.program.emit('mouse', { x, y, action: 'mousedown', shift: false });
    tui.screen.program.emit('mouse', { x: x + 4, y, action: 'mouseup', shift: false });
    await flush();

    const files = fs.readdirSync(clipboardDir).filter((name) => name.startsWith('.moncho.clipboard.'));
    assert.deepEqual(files, [], 'the in-app selection is not installed, so no file was written');
  }, { columns: 80, rows: 24, nativeSelection: true });
});
