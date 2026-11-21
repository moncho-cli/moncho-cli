import test from 'node:test';
import assert from 'node:assert/strict';

import { createToastBar } from '../app/tui-toast.js';
import { createToast, TOAST_TTL_MS } from '../app/toast.js';
import { withTui } from './support/tui-harness.js';

/**
 * The toast *binding* (`docs/interface/clipboard-selection`): where the box sits, how wide
 * it gets, when it hides itself. The model is covered without a screen in
 * `tests/toast.test.js`; this file proves the box obeys it.
 */

const flush = async (rounds = 4) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the toast box appears with its message and hides itself on a timer', async () => {
  await withTui(async (tui) => {
    // A 30 ms lifetime, so the test watches the real timer rather than waiting four
    // seconds: the arming logic is the same one the four-second default uses.
    let at = 1_000_000;
    const bar = createToastBar({
      screen: tui.screen,
      ttlMs: 30,
      toast: createToast({ ttlMs: 30, now: () => at }),
      refresh: () => {},
    });

    assert.equal(bar.widget.hidden, true, 'nothing to say, no box');

    bar.show('Copied text to clipboard');
    assert.equal(bar.widget.hidden, false, 'the box appears with the message');
    assert.equal(bar.widget.getContent(), 'Copied text to clipboard');
    assert.equal(bar.visible, true);

    // Let real time pass beyond the lifetime, and let the armed timer run.
    at += 31;
    await wait(50);
    await flush();
    assert.equal(bar.visible, false, 'it went away by itself, with no call from anyone');
    assert.equal(bar.widget.hidden, true, 'and the box is hidden again');

    bar.close();
  });
}, { columns: 100, rows: 24 });

test('the four-second default is what a copy actually gets', async () => {
  await withTui(async (tui) => {
    const bar = createToastBar({ screen: tui.screen, refresh: () => {} });
    bar.show('Copied text to clipboard');
    assert.equal(TOAST_TTL_MS, 4000);
    const left = bar.timeToHide();
    assert.ok(left > 3900 && left <= 4000, `about four seconds left, was ${left}`);
    bar.close();
  });
}, { columns: 100, rows: 24 });

test('the toast box is top-right and only as wide as its sentence', async () => {
  await withTui(async (tui) => {
    const bar = createToastBar({ screen: tui.screen, refresh: () => {} });

    bar.show('Copied text to clipboard');
    assert.equal(bar.widget.right, 0, 'pinned to the right edge');
    assert.equal(bar.widget.top, 1, 'one row down, clear of the brand line');
    // The sentence is 24 cells; the box carries the border and one column of padding each
    // side, so it is bounded well inside a 100-column screen.
    assert.ok(bar.widget.width >= 24, 'wide enough for the sentence');
    assert.ok(bar.widget.width < 60, 'not stretched across the screen');

    // A shorter message makes a smaller box: the width follows the text.
    const wide = bar.widget.width;
    bar.show('ok');
    assert.ok(bar.widget.width < wide, 'a shorter sentence narrows the box');

    bar.close();
  });
}, { columns: 100, rows: 24 });

test('a copy raises the confirmation and the provider overlay is not used for it', async () => {
  await withTui(async (tui) => {
    tui.log('some prose to drag over');
    await flush();

    const transcript = tui.transcript;
    const x = transcript.lpos.xi + transcript.ileft;
    const y = transcript.lpos.yi + transcript.itop;
    const mouse = (action, mx, my) => tui.screen.program.emit('mouse', { x: mx, y: my, action });

    mouse('mousedown', x, y);
    mouse('mouseup', x + 4, y);
    await flush();

    assert.equal(tui.toastText, 'Copied text to clipboard');
    assert.equal(tui.notices.length, 0, 'the provider notice overlay is not used for this');
  });
}, { columns: 100, rows: 24 });