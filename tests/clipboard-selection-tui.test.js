import test from 'node:test';
import assert from 'node:assert/strict';

import { sliceCells } from '../app/transcript-select.js';
import { withTui, visible } from './support/tui-harness.js';
import { clipboardText } from './support/clipboard-text.js';

/**
 * The whole gesture through a real neo-blessed screen (docs/interface/clipboard-selection).
 *
 * Only an end-to-end drag can prove the design, because the order the edges arrive in is
 * blessed's. Two rules matter here and both were learned the hard way:
 *
 *  - the release itself must finish the gesture, because a terminal that was not asked for
 *    all-motion tracking sends no `mousemove` while the button is down — a drag then
 *    arrives as `mousedown` + `mouseup` and nothing else;
 *  - a plain click still falls through to the block toggle, so the band must never eat it.
 */

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** The cells the mouse addresses, from the widget's own painted origin. */
function origin(transcript) {
  return {
    x: transcript.lpos.xi + transcript.ileft,
    y: transcript.lpos.yi + transcript.itop,
  };
}

test('a release copies the selection and a plain click still toggles a block', async () => {
  await withTui(async (tui) => {
    tui.log('alpha bravo charlie');
    tui.log('delta echo foxtrot');
    const block = tui.logBlock({ header: '  [read_file Output]', body: 'one\ntwo' });
    await flush();

    // Capture what the TUI's own clipboard writer puts on the terminal.
    const frames = [];
    const realWrite = tui.screen.program.write.bind(tui.screen.program);
    tui.screen.program.write = (text) => { frames.push(String(text)); return realWrite(text); };

    const transcript = tui.transcript;
    const { x, y } = origin(transcript);
    const mouse = (action, mx, my) => tui.screen.program.emit('mouse', { x: mx, y: my, action });

    // Press, drag to cell 5 of the second row, release — with no further motion, which is
    // what a terminal without all-motion tracking reports.
    mouse('mousedown', x, y);
    assert.equal(tui.selection.dragging, true, 'the press opens a gesture');
    mouse('mouseup', x + 5, y + 1);
    await flush();

    const sequence = frames.find((frame) => frame.includes(']52;'));
    assert.ok(sequence, 'the release wrote an OSC 52 sequence');
    const copied = clipboardText(sequence);
    const [first, second] = tui.transcriptModel.lines;
    assert.equal(copied.split('\n')[0], first, 'the first row is copied whole');
    assert.equal(copied.split('\n')[1], sliceCells(second, 0, 5), 'the second row is cut at the release');

    // The band is gone and the gesture is over: the release ends it, copied or not.
    assert.equal(tui.selectionRange, null, 'the gesture is over');
    assert.doesNotMatch(transcript.getContent(), /\x1b\[7m/, 'the band left the screen');
    assert.equal(block.collapsed, true, 'the drag did not toggle the block it passed over');

    // A plain click on the block still toggles it: the selection never ate the click.
    const range = tui.transcriptModel.rangeOf(block);
    const by = transcript.lpos.yi + transcript.itop + (range.start - (transcript.childBase || 0));
    mouse('mousedown', x + 1, by);
    mouse('mouseup', x + 1, by);
    await flush();
    assert.equal(block.collapsed, false, 'a plain click expands the tool result');
  });
}, { columns: 80, rows: 24 });

test('a drag copies the line it started on, not the one below it', async () => {
  await withTui(async (tui) => {
    // A line long enough that blessed splits it across two screen rows: the copy must
    // still start at that line, because a mouse point names a *line*, not a screen row.
    tui.log(`AAA ${'x'.repeat(140)} ZZZ`);
    tui.log('SECOND short line');
    await flush();

    const frames = [];
    const realWrite = tui.screen.program.write.bind(tui.screen.program);
    tui.screen.program.write = (text) => { frames.push(String(text)); return realWrite(text); };

    const transcript = tui.transcript;
    const lines = tui.transcriptModel.lines;
    const { x, y } = origin(transcript);
    const mouse = (action, mx, my) => tui.screen.program.emit('mouse', { x: mx, y: my, action });

    // Drag from the first cell of the first line down into the second line.
    mouse('mousedown', x, y);
    mouse('mouseup', x + 6, y + 2);
    await flush();

    const copied = clipboardText(frames.find((frame) => frame.includes(']52;')));
    assert.ok(copied, 'the drag copied something');
    const rows = copied.split('\n');
    // The very first character copied is the first line's first cell — the bug this fixes
    // was the copy starting a line lower, on the text below the pointer.
    assert.equal(rows[0][0], lines[0][0], 'the copy starts on the line under the press');
    assert.match(rows[0], /AAA/, 'the wrapped line is the one copied first');
    assert.ok(rows.length >= 2, 'the drag reached the second line as well');
  });
}, { columns: 80, rows: 24 });

test('the copy is confirmed in the top-right toast and never enters the conversation', async () => {
  await withTui(async (tui) => {
    tui.log('some prose to drag over');
    await flush();

    const transcript = tui.transcript;
    const { x, y } = origin(transcript);
    const before = tui.transcriptModel.lines.length;
    const mouse = (action, mx, my) => tui.screen.program.emit('mouse', { x: mx, y: my, action });

    mouse('mousedown', x, y);
    mouse('mouseup', x + 4, y);
    await flush();

    // The confirmation is the plain sentence in a corner, not a row in the dialogue: the
    // copy is about the reader's clipboard, and it must never reach the model.
    assert.equal(tui.transcriptModel.lines.length, before, 'the conversation gained no row');
    assert.match(visible(tui), /some prose to drag over/, 'the transcript still shows what it did');
    assert.equal(tui.toastText, 'Copied text to clipboard');
    assert.equal(tui.toastVisible, true);

    // It is a toast, not a transcript row, and it goes away on its own.
    assert.equal(tui.toastBar.widget.hidden, false, 'the box is shown');
    assert.equal(tui.toastBar.widget.right, 0, 'pinned to the right edge');
    assert.ok(tui.toastBar.widget.top >= 0 && tui.toastBar.widget.top < 3, 'near the top');
    assert.ok(tui.toastBar.timeToHide() <= 4000, 'it will hide itself within four seconds');
  });
}, { columns: 80, rows: 24 });