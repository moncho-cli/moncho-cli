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

    // Press, drag with the button held (32), release on the second row. No modifier: a
    // plain drag is what this program answers (Shift+drag is the terminal's own, see
    // app/transcript-mouse.js).
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

test('the app asks for SGR, so a release carrying a modifier still reads as a mouseup', async () => {
  await withTui(async (tui, { input, chunks, clipboardDir }) => {
    // The regression guard for the encoding. blessed picks the mouse protocol from $TERM and
    // would ask for ?1005 (UTF-8 extended X10), whose button byte carries no *edge*: its
    // decoder does `b -= 32`, tests `b === 3` and misses for any modifier, so a release with
    // Shift (35 + 4 = 39 -> 7) arrives as `mousedown button:unknown`. The gesture finishes on
    // `mouseup`, so such a release never finishes it and the band is left stranded on screen.
    //
    // The suite writes SGR reports, so it passes only while the app really asks for SGR.
    // Asserting the modes is what ties the two together: without this line a revert to ?1005
    // would leave every other case here green while a modified release stranded the band.
    const negotiated = chunks.join('');
    assert.match(negotiated, /\?1006h/, 'the app asks for SGR, which the tests then speak');
    assert.doesNotMatch(negotiated, /\?1005h/, 'and not the X10 encoding whose release byte cannot carry a modifier');

    tui.log('alpha bravo charlie');
    await flush();

    const { x, y } = origin(tui.transcript);
    const lines = tui.transcriptModel.lines;

    // A drag with the modifier bit set: cb 4 press, cb 36 drag, cb 7 release. Under SGR each
    // is what it says — press, press, mouseup — so the gesture finishes and copies.
    input.write(report(4, x, y, 'mousedown'));
    input.write(report(36, x + 5, y, 'mousedown'));
    await flush(2);
    assert.match(tui.transcript.getContent(), /\x1b\[7m/, 'the drag painted the band');

    input.write(report(7, x + 5, y, 'mouseup'));
    await flush(2);

    // The release finished it: the band is gone and the text was saved.
    assert.doesNotMatch(tui.transcript.getContent(), /\x1b\[7m/, 'the modified release cleared the band');
    assert.equal(tui.selectionRange, null, 'the gesture is over');
    const saved = clipboardFiles(clipboardDir);
    assert.equal(saved.length, 1, 'the modified release copied exactly once');
    assert.equal(saved[0].text, sliceCells(lines[0], 0, 5), 'and copied what was dragged over');
  });
}, { columns: 80, rows: 24 });

/**
 * A drag burst is the reason the band is coalesced: blessed decodes a chunk of input and
 * emits every report it held in the same turn, so one flick of the wrist is dozens of
 * reports before the event loop turns. Counting `setContent()` is counting paints, and one
 * paint re-renders the whole conversation — which is the lag a long transcript shows.
 */
test('a burst of drag steps paints once per turn, not once per report', async () => {
  await withTui(async (tui, { input }) => {
    for (let i = 0; i < 60; i += 1) tui.log(`line ${i} alpha bravo charlie delta echo foxtrot`);
    await flush();

    const { x, y } = origin(tui.transcript);
    let paints = 0;
    const real = tui.transcript.setContent.bind(tui.transcript);
    tui.transcript.setContent = (content) => { paints += 1; return real(content); };

    // Every report written back to back, so they decode in one turn. The pointer moves each
    // step (so each is a genuine change, not a duplicate to be ignored).
    input.write(report(0, x, y, 'mousedown'));
    for (let s = 1; s <= 30; s += 1) input.write(report(32, x + s, y, 'mousedown'));
    input.write(report(32, x + 30, y, 'mouseup'));
    await flush();

    assert.ok(paints > 0, 'the drag did paint');
    assert.ok(paints <= 4, `a 30-step burst painted only a few times, got ${paints}`);
  });
}, { columns: 80, rows: 24 });

test('the final position of a burst is the one painted, and the release paints at once', async () => {
  await withTui(async (tui, { input, clipboardDir }) => {
    tui.log('alpha bravo charlie delta echo');
    tui.log('foxtrot golf hotel india juliet');
    await flush();

    const { x, y } = origin(tui.transcript);
    const lines = tui.transcriptModel.lines;

    // A burst whose last step is well past its first: coalescing must paint the *last* point,
    // not the first, or the band (and the copy) would be short.
    input.write(report(0, x, y, 'mousedown'));
    for (let s = 1; s <= 6; s += 1) input.write(report(32, x + s, y + 1, 'mousedown'));
    await flush(2);
    assert.match(tui.transcript.getContent(), /\x1b\[7m/, 'the band is up mid-burst');

    // The release paints immediately: the band is gone the moment it settles, not a turn later.
    input.write(report(32, x + 6, y + 1, 'mouseup'));
    await flush(2);
    assert.doesNotMatch(tui.transcript.getContent(), /\x1b\[7m/, 'the release cleared the band at once');

    const saved = clipboardFiles(clipboardDir);
    assert.equal(saved.length, 1, 'the burst saved exactly one file');
    assert.equal(
      saved[0].text,
      `${lines[0]}\n${sliceCells(lines[1], 0, 6)}`,
      'and saved from the press to the last point of the burst',
    );
  });
}, { columns: 80, rows: 24 });
