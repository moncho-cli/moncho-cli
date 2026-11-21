import test from 'node:test';
import assert from 'node:assert/strict';

import { createToastBar } from '../app/tui-toast.js';
import { createToast, TOAST_TTL_MS } from '../app/toast.js';
import { withTui, clipboardFiles } from './support/tui-harness.js';

/**
 * The toast *binding* (`docs/interface/clipboard-selection`): where the box sits, how wide
 * it is, when it hides itself. The model is covered without a screen in
 * `tests/toast.test.js`; this file proves the box obeys it.
 */

const flush = async (rounds = 4) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SENTENCE = 'Saved data to .moncho.clipboard.093015';

test('the toast box appears with its message and hides itself on a timer', async () => {
  await withTui(async (tui) => {
    // A 30 ms lifetime, so the test watches the real timer without waiting four seconds.
    const bar = createToastBar({ screen: tui.screen, refresh: () => {}, ttlMs: 30 });
    bar.show(SENTENCE);
    assert.equal(bar.widget.hidden, false, 'the box is visible while the sentence lives');
    assert.equal(bar.visible, true);

    await wait(60);
    await flush();
    assert.equal(bar.widget.hidden, true, 'the box hides itself');
    bar.close();
  });
}, { columns: 100, rows: 24 });

test('the four-second default is what a copy actually gets', async () => {
  await withTui(async (tui) => {
    const toast = createToast();
    const bar = createToastBar({ screen: tui.screen, refresh: () => {}, toast });
    bar.show(SENTENCE);
    assert.equal(TOAST_TTL_MS, 4000);
    assert.ok(bar.timeToHide() <= TOAST_TTL_MS, 'the default lifetime is four seconds');
    bar.close();
  });
}, { columns: 100, rows: 24 });

test('the toast box is top-right and only as wide as its sentence', async () => {
  await withTui(async (tui) => {
    const bar = createToastBar({ screen: tui.screen, refresh: () => {} });
    bar.show(SENTENCE);
    assert.equal(bar.widget.right, 0, 'pinned to the right edge');
    assert.ok(bar.widget.top >= 0 && bar.widget.top < 3, 'near the top');
    assert.ok(bar.widget.width < 60, 'only as wide as the sentence');
    bar.close();
  });
}, { columns: 100, rows: 24 });

test('a copy raises the confirmation and the provider overlay is not used for it', async () => {
  await withTui(async (tui, { clipboardDir }) => {
    tui.log('some prose to drag over');
    await flush();

    const transcript = tui.transcript;
    const x = transcript.lpos.xi + transcript.ileft;
    const y = transcript.lpos.yi + transcript.itop;
    const mouse = (action, mx, my) => tui.screen.program.emit('mouse', { x: mx, y: my, action });

    mouse('mousedown', x, y);
    mouse('mouseup', x + 4, y);
    await flush();

    const saved = clipboardFiles(clipboardDir);
    assert.equal(saved.length, 1, 'the drag saved a file');
    assert.equal(tui.toastText, `Saved data to ${saved[0].name}`, 'the toast names the file');
    assert.equal(tui.notices.length, 0, 'the provider notice overlay is not used for this');
  });
}, { columns: 100, rows: 24 });
