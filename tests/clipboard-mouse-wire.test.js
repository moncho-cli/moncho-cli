import test from 'node:test';
import assert from 'node:assert/strict';

import { sliceCells } from '../app/transcript-select.js';
import { withTui } from './support/tui-harness.js';
import { clipboardText } from './support/clipboard-text.js';

/**
 * The gesture driven by the bytes a **real terminal** sends, not by synthetic actions.
 *
 * This file exists because the other clipboard suites passed while the feature was broken.
 * They drive blessed through `program.emit('mouse', { action })` — its own abstraction —
 * and the bug lived *between* the terminal and that abstraction, in blessed's decoder. So
 * the reports here are written as the SGR encoding (CSI `<` Cb `;` Cx `;` Cy M/m) that a
 * modern terminal actually emits, and three load-bearing rules come out of it:
 *
 *  - **a drag step is reported as `mousedown`.** blessed recognises motion only from the
 *    *no-button* codes (`node_modules/neo-blessed/lib/program.js#_bindMouse`:
 *    `b === 35 || 39 || 51 || 43`), and a drag carries the button bit, so it falls through
 *    to `mousedown` — with the new coordinates. A gesture that re-anchored on every press
 *    therefore restarted at every step and finished with a zero-width range, which is why a
 *    drag copied nothing while holding Shift (which adds 4 to the code) appeared to work;
 *  - **the release is `mouseup` *and* `click`**, click first, for the same report;
 *  - **`mousemove` is only ever a hover** — motion with no button held.
 *
 * `Cb` carries the button in its low bits: 0 is the left button, +32 means "moving with a
 * button held", and 35 is motion with no button. The terminator is `M` for a press and `m`
 * for a release.
 *
 * **Coordinates are 1-based on the wire**, and blessed subtracts one
 * (`program.js#_bindMouse`: `if (this.zero) key.x--, key.y--`). So a report for the screen
 * cell `(x, y)` carries `x + 1` and `y + 1` — writing the 0-based cell instead lands the
 * whole selection one column left and one row up, which is a mistake this file already made
 * once.
 */

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** The screen cells the mouse addresses: the widget's painted origin of its content. */
function origin(transcript) {
  return { x: transcript.lpos.xi + transcript.ileft, y: transcript.lpos.yi + transcript.itop };
}

/** One SGR mouse report for the screen *cell* `(x, y)`, as xterm writes it (1-based). */
const report = (cb, x, y, term = 'M') => `\x1b[<${cb};${x + 1};${y + 1}${term}`;

const LEFT_DOWN = 0;
const LEFT_DRAG = 32;
const HOVER = 35;

test('a drag as a terminal sends it copies what was dragged over, exactly once', async () => {
  await withTui(async (tui, { input }) => {
    tui.log('alpha bravo charlie');
    tui.log('delta echo foxtrot');
    await flush();

    const written = [];
    const realWrite = tui.screen.program.write.bind(tui.screen.program);
    tui.screen.program.write = (text) => { written.push(String(text)); return realWrite(text); };

    const lines = tui.transcriptModel.lines;
    const { x, y } = origin(tui.transcript);

    // Press on the first line, drag along it, down onto the second, and release there.
    // Every step arrives as `mousedown` — no `mousemove` anywhere, which is what a real
    // terminal sends for a drag.
    input.write(report(LEFT_DOWN, x, y));
    input.write(report(LEFT_DRAG, x + 8, y));
    input.write(report(LEFT_DRAG, x + 6, y + 1));
    input.write(report(LEFT_DOWN, x + 5, y + 1, 'm'));
    await flush();

    const sequences = written.filter((text) => text.includes(']52;'));
    assert.equal(sequences.length, 1, 'copied exactly once, despite both mouseup and click');

    const copied = clipboardText(sequences[0]);
    // The copy starts at the PRESS cell, not at the last drag step: the anchor is the press
    // point, and the regression this file was written to catch restarted it at every step.
    assert.equal(
      copied,
      `${lines[0]}\n${sliceCells(lines[1], 0, 5)}`,
      'the drag selected from the press to the release',
    );
    assert.equal(tui.selectionRange, null, 'the gesture is over');
    assert.doesNotMatch(tui.transcript.getContent(), /\x1b\[7m/, 'the band left the screen');
    assert.equal(tui.toastText, 'Copied text to clipboard', 'the reader is told');
  });
}, { columns: 80, rows: 24 });

test('the band follows a drag that arrives as repeated presses, and clears on release', async () => {
  await withTui(async (tui, { input }) => {
    tui.log('alpha bravo charlie delta');
    await flush();

    const { x, y } = origin(tui.transcript);
    const band = () => tui.transcript.getContent().includes('\x1b[7m');

    assert.equal(band(), false, 'nothing selected before the press');

    input.write(report(LEFT_DOWN, x, y));
    await flush(2);
    assert.equal(band(), false, 'a bare press has not selected anything yet');
    assert.equal(tui.selectionRange, null, 'a press alone is not a selection');

    // The drag step: a *second* press, which is how blessed reports motion with a button
    // held. It must extend the gesture from the press, not restart it, and repaint the band.
    input.write(report(LEFT_DRAG, x + 10, y));
    await flush(2);
    assert.equal(band(), true, 'the band appears as the drag extends');
    assert.deepEqual(tui.selectionRange, { anchor: { row: 0, cell: 0 }, focus: { row: 0, cell: 10 } });

    // A second drag step must keep the anchor where it was and only move the focus.
    input.write(report(LEFT_DRAG, x + 15, y));
    await flush(2);
    assert.deepEqual(tui.selectionRange, { anchor: { row: 0, cell: 0 }, focus: { row: 0, cell: 15 } });

    input.write(report(LEFT_DOWN, x + 15, y, 'm'));
    await flush();
    assert.equal(band(), false, 'the band is cleared on release');
    assert.equal(tui.selectionRange, null, 'and the gesture is over');
  });
}, { columns: 80, rows: 24 });

test('a pointer moving with no button held selects nothing', async () => {
  await withTui(async (tui, { input }) => {
    tui.log('alpha bravo charlie');
    await flush();

    const before = tui.transcript.getContent();
    const { x, y } = origin(tui.transcript);

    // Motion with no button: a hover crossing the conversation. It must not open a gesture,
    // must not repaint the band, and must not copy.
    input.write(report(HOVER, x, y));
    input.write(report(HOVER, x + 12, y));
    await flush();

    assert.equal(tui.selectionRange, null, 'a hover selects nothing');
    assert.equal(tui.selection.dragging, false, 'no gesture was opened');
    assert.equal(tui.transcript.getContent(), before, 'the conversation was not repainted');
    assert.equal(tui.toastVisible, false, 'nothing was copied, so nothing is announced');
  });
}, { columns: 80, rows: 24 });

test('a release outside the transcript still finishes the gesture, and a drag over the edge copies to the end', async () => {
  await withTui(async (tui, { input }) => {
    // Two lines, so "past the last row" is unambiguous.
    tui.log('alpha bravo charlie');
    tui.log('delta echo foxtrot');
    await flush();

    const written = [];
    const realWrite = tui.screen.program.write.bind(tui.screen.program);
    tui.screen.program.write = (text) => { written.push(String(text)); return realWrite(text); };

    const { x, y } = origin(tui.transcript);
    const lines = tui.transcriptModel.lines;
    // Two rows below the pane's bottom edge: over the status bar and the input box, which
    // are the regions a reader drags into by accident.
    const outside = tui.transcript.lpos.yl + 2;

    input.write(report(LEFT_DOWN, x, y));
    await flush(2);

    // The drag leaves the pane. blessed does not deliver this press to the transcript at
    // all — the region under the pointer answers it — so the binding has to take it on the
    // screen, and only because a gesture is already live. The focus follows anyway, so the
    // selection grows rather than freezing at the pane's edge.
    input.write(report(LEFT_DRAG, x + 4, outside));
    await flush(2);
    assert.equal(tui.selection.dragging, true, 'the gesture is still live out there');
    assert.deepEqual(
      tui.selectionRange,
      { anchor: { row: 0, cell: 0 }, focus: { row: lines.length - 1, cell: 4 } },
      'the focus followed the pointer out of the pane, clamped to the last drawn row',
    );

    // Released out there too. This is the bug that was reported: nothing came back, so the
    // conversation stayed stuck as a held press.
    input.write(report(LEFT_DOWN, x + 4, outside, 'm'));
    await flush();

    assert.equal(tui.selection.dragging, false, 'the release outside finished the gesture');
    assert.equal(tui.selectionRange, null, 'the selection was cleared');
    assert.doesNotMatch(tui.transcript.getContent(), /\x1b\[7m/, 'the band left the screen');

    const sequences = written.filter((text) => text.includes(']52;'));
    assert.equal(sequences.length, 1, 'the out-of-bounds release copied exactly once');
    assert.equal(
      clipboardText(sequences[0]),
      `${lines[0]}\n${sliceCells(lines[1], 0, 4)}`,
      'a drag released past the end copies to the end of the content, not past it',
    );
    assert.equal(tui.toastText, 'Copied text to clipboard');
  });
}, { columns: 80, rows: 24 });

test('a press outside the pane never starts a selection', async () => {
  await withTui(async (tui, { input }) => {
    tui.log('alpha bravo charlie');
    await flush();

    const { x } = origin(tui.transcript);
    // The input box owns the bottom of the screen. A press there is a click on the box, not
    // the start of a selection: the screen sees every press, so the binding must ignore the
    // ones that arrive with no gesture in flight.
    const inputRow = tui.inputBox.lpos.yi + tui.inputBox.itop;
    input.write(report(LEFT_DOWN, x, inputRow));
    await flush(2);
    input.write(report(LEFT_DRAG, x + 6, inputRow));
    await flush(2);
    input.write(report(LEFT_DOWN, x + 6, inputRow, 'm'));
    await flush();

    assert.equal(tui.selection.dragging, false, 'no gesture was opened by a click on the input box');
    assert.equal(tui.selectionRange, null, 'and nothing was selected');
    assert.equal(tui.toastVisible, false, 'and nothing was copied');
  });
}, { columns: 80, rows: 24 });