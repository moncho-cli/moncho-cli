import test from 'node:test';
import assert from 'node:assert/strict';

import { sliceCells } from '../app/transcript-select.js';
import { withTui, clipboardFiles } from './support/tui-harness.js';

/**
 * The gesture driven by the bytes a **real terminal** sends, not by synthetic actions.
 *
 * This file exists because the other clipboard suites passed while the feature was broken.
 * It drives blessed through `program.emit('mouse')` — its own abstraction — while the bug
 * was *between* the terminal and blessed's decoder. So the reports here are written as the
 * SGR encoding (CSI Cb;Cx;Cy M) that a modern terminal actually emits, and three
 * load-bearing rules come out of it:
 *
 *  - a drag step is reported as `mousedown`, carrying the button bit (32), so the gesture
 *    must be extended rather than re-anchored;
 *  - the release is `mouseup` plus the `click` blessed also emits for the same press;
 *  - a hover (no button, code 35) is motion without a press and selects nothing.
 *
 * Coordinates are 1-based on the wire, so the report subtracts nothing and the assertions
 * compare against the same cells the mouse names.
 */

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** The screen cells the mouse addresses, from the widget's painted origin. */
function origin(transcript) {
  return { x: transcript.lpos.xi + transcript.ileft, y: transcript.lpos.yi + transcript.itop };
}

/** An SGR mouse report at 1-based wire coordinates. */
const report = (cb, x, y, action) => {
  const term = action === 'mouseup' ? 'm' : 'M';
  return `\x1b[<${cb};${x + 1};${y + 1}${term}`;
};

test('a drag as a terminal sends it saves what was dragged over, exactly once', async () => {
  await withTui(async (tui, { input, clipboardDir }) => {
    tui.log('alpha bravo charlie');
    tui.log('delta echo foxtrot');
    await flush();

    const { x, y } = origin(tui.transcript);
    const lines = tui.transcriptModel.lines;

    // Press, drag with the button held (32), release on the second row.
    input.write(report(0, x, y, 'mousedown'));
    input.write(report(32, x + 5, y + 1, 'mousedown'));
    input.write(report(32, x + 5, y + 1, 'mouseup'));
    await flush();

    const saved = clipboardFiles(clipboardDir);
    assert.equal(saved.length, 1, 'the drag saved exactly one file');
    assert.equal(
      saved[0].text,
      `${lines[0]}\n${sliceCells(lines[1], 0, 5)}`,
      'the drag saved from the press to the release',
    );
    assert.equal(tui.selectionRange, null, 'the gesture is over');
    assert.doesNotMatch(tui.transcript.getContent(), /\x1b\[7m/, 'the band left the screen');
    assert.equal(tui.toastText, `Saved data to ${saved[0].name}`, 'the reader is told');
  });
}, { columns: 80, rows: 24 });

test('the band follows a drag that arrives as repeated presses, and clears on release', async () => {
  await withTui(async (tui, { input }) => {
    tui.log('alpha bravo charlie delta');
    await flush();

    const { x, y } = origin(tui.transcript);
    const band = () => tui.transcript.getContent().includes('\x1b[7m');

    input.write(report(0, x, y, 'mousedown'));
    await flush(2);
    assert.equal(band(), false, 'a press alone opens the gesture without a band');

    input.write(report(32, x + 4, y, 'mousedown'));
    await flush(2);
    assert.equal(band(), true, 'the drag paints the band');

    input.write(report(32, x + 4, y, 'mouseup'));
    await flush(2);
    assert.equal(band(), false, 'the release clears the band');
    assert.equal(tui.selectionRange, null, 'the gesture is over');
  });
}, { columns: 80, rows: 24 });

test('a pointer moving with no button held selects nothing', async () => {
  await withTui(async (tui, { input, clipboardDir }) => {
    tui.log('alpha bravo charlie');
    await flush();

    const { x, y } = origin(tui.transcript);
    input.write(report(35, x + 2, y, 'mousedown'));
    await flush(2);

    assert.equal(tui.selectionRange, null, 'a hover selects nothing');
    assert.deepEqual(clipboardFiles(clipboardDir), [], 'nothing was saved');
    assert.equal(tui.toastVisible, false, 'nothing is announced');
  });
}, { columns: 80, rows: 24 });

test('a release outside the transcript still finishes the gesture, and a drag over the edge saves to the end', async () => {
  await withTui(async (tui, { input, clipboardDir }) => {
    tui.log('alpha bravo charlie');
    tui.log('delta echo foxtrot');
    await flush();

    const { x, y } = origin(tui.transcript);
    const lines = tui.transcriptModel.lines;
    const outside = tui.transcript.lpos.yl + 2;

    input.write(report(0, x, y, 'mousedown'));
    input.write(report(32, x + 3, outside, 'mousedown'));
    input.write(report(32, x + 3, outside, 'mouseup'));
    await flush();

    const saved = clipboardFiles(clipboardDir);
    assert.equal(saved.length, 1, 'the out-of-bounds release saved once');
    assert.equal(
      saved[0].text,
      `${lines[0]}\n${sliceCells(lines[1], 0, 3)}`,
      'the drag clamped to the drawn content',
    );
    assert.equal(tui.toastText, `Saved data to ${saved[0].name}`);
  });
}, { columns: 80, rows: 24 });

test('a press outside the pane never starts a selection', async () => {
  await withTui(async (tui, { input, clipboardDir }) => {
    tui.log('alpha bravo charlie');
    await flush();

    const { x } = origin(tui.transcript);
    const inputRow = tui.inputBox.lpos.yi + tui.inputBox.itop;
    input.write(report(0, x, inputRow, 'mousedown'));
    input.write(report(0, x, inputRow, 'mouseup'));
    await flush(2);

    assert.deepEqual(clipboardFiles(clipboardDir), [], 'a press on the input box saved nothing');
    assert.equal(tui.toastVisible, false);
  });
}, { columns: 80, rows: 24 });
