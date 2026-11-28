import test from 'node:test';
import assert from 'node:assert/strict';

import { sliceCells } from '../app/transcript-select.js';
import { withTui, visible, clipboardFiles } from './support/tui-harness.js';

/**
 * The whole gesture through a real neo-blessed screen (docs/interface/clipboard-selection).
 *
 * Only an end-to-end drag can prove the design, because the order the edges arrive in is
 * blessed's. Two rules matter here and both were learned the hard way:
 *
 *  - the release itself must end the gesture, because a plain click still toggles a block;
 *  - the copy is a file in the workspace, so the assertions read the directory the TUI
 *    wrote into rather than a byte stream on the terminal.
 */

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** The cells the mouse addresses, from its own painted origin. */
function origin(transcript) {
  return { x: transcript.lpos.xi + transcript.ileft, y: transcript.lpos.yi + transcript.itop };
}

test('a release saves the selection and a plain click still toggles a block', async () => {
  await withTui(async (tui, { clipboardDir }) => {
    tui.log('alpha bravo charlie');
    tui.log('delta echo foxtrot');
    const block = tui.logBlock({ header: 'read_file Output', body: 'body text' });
    await flush();

    const transcript = tui.transcript;
    const { x, y } = origin(transcript);
    const mouse = (action, mx, my) => tui.screen.program.emit('mouse', { x: mx, y: my, action });

    // Press, drag to cell 5 of the second row, release. The release stays on the log rows,
    // so the block below is never touched by the gesture.
    mouse('mousedown', x, y);
    mouse('mouseup', x + 5, y + 1);
    await flush();

    const saved = clipboardFiles(clipboardDir);
    assert.equal(saved.length, 1, 'the release saved exactly one file');
    assert.match(saved[0].name, /^\.moncho\.clipboard\.\d{6}$/, 'the file carries the time name');
    const [first, second] = tui.transcriptModel.lines;
    const savedRows = saved[0].text.split('\n');
    assert.equal(savedRows[0], first, 'the first row is saved whole');
    // The release landed partway along the second log row, so the saved text spans two
    // rows: the first whole and the second cut short. Its row carries the transcript's own
    // timestamp prefix, so the saved row is a prefix of the drawn row.
    assert.equal(savedRows.length, 2, 'the drag covered exactly two rows');
    assert.ok(second.startsWith(savedRows[1]), 'the saved second row starts where the drawn row does');
    assert.ok(savedRows[1].length < second.length, 'the second row is cut short of its end');

    // The band is gone and the gesture is over, copied or not. The block starts
    // collapsed, so expanding it proves the drag passed over it without toggling it.
    assert.equal(tui.selectionRange, null, 'the gesture is over');
    assert.doesNotMatch(transcript.getContent(), /\x1b\[7m/, 'the band left the screen');
    assert.equal(block.collapsed, true, 'the drag did not toggle the block it passed');

    // A plain click still toggles the block. The row is computed from the model's own
    // range, the same arithmetic the block click uses, so the click lands on the block.
    const range = tui.transcriptModel.rangeOf(block);
    const by = transcript.lpos.yi + transcript.itop + (range.start - (transcript.childBase || 0));
    mouse('mousedown', x + 1, by);
    mouse('mouseup', x + 1, by);
    await flush();
    assert.equal(block.collapsed, false, 'the plain click expanded the block');
  });
}, { columns: 80, rows: 24 });

test('a drag saves the line it started on, not the one below it', async () => {
  await withTui(async (tui, { clipboardDir }) => {
    tui.log('AAA bravo charlie');
    tui.log('delta echo foxtrot');
    await flush();

    const transcript = tui.transcript;
    const { x, y } = origin(transcript);
    const mouse = (action, mx, my) => tui.screen.program.emit('mouse', { x: mx, y: my, action });

    mouse('mousedown', x, y);
    mouse('mouseup', x + 3, y + 1);
    await flush();

    const saved = clipboardFiles(clipboardDir);
    assert.equal(saved.length, 1, 'the drag saved a file');
    const lines = saved[0].text.split('\n');
    assert.equal(lines[0], tui.transcriptModel.lines[0], 'the first row is saved whole');
    assert.match(lines[0], /AAA/, 'the wrapped line is the one saved first');
  });
}, { columns: 80, rows: 24 });

test('the copy is confirmed in the top-right toast and never enters the conversation', async () => {
  await withTui(async (tui, { clipboardDir }) => {
    tui.log('some prose to drag over');
    await flush();

    const transcript = tui.transcript;
    const { x, y } = origin(transcript);
    const before = tui.transcriptModel.lines.length;
    const mouse = (action, mx, my) => tui.screen.program.emit('mouse', { x: mx, y: my, action });

    mouse('mousedown', x, y);
    mouse('mouseup', x + 4, y);
    await flush();

    // The confirmation names the file, and it is a toast — not a row in the conversation.
    const saved = clipboardFiles(clipboardDir);
    assert.equal(saved.length, 1);
    assert.equal(tui.toastText, `Saved data to ${saved[0].name}`);
    assert.equal(tui.toastVisible, true);
    assert.equal(tui.transcriptModel.lines.length, before, 'the conversation gained no row');
    assert.match(visible(tui), /some prose to drag over/, 'the transcript is untouched');

    // The toast box is top-right and hides itself.
    assert.equal(tui.toastBar.widget.hidden, false);
    assert.equal(tui.toastBar.widget.right, 0, 'pinned to the right edge');
    assert.ok(tui.toastBar.widget.top >= 0 && tui.toastBar.widget.top < 3, 'near the top');
  });
}, { columns: 100, rows: 24 });

test('a drag released below the pane copies exactly the rows on screen', async () => {
  await withTui(async (tui, { clipboardDir }) => {
    for (let i = 1; i <= 80; i += 1) tui.log(`LINE-${String(i).padStart(3, '0')} content`);
    await flush();

    const transcript = tui.transcript;
    // Scrolled up, which is the state a reader reaches for older text in, and what the bug
    // needed: the clamp for a release past the pane used to be `childBase + _clines.length - 1`,
    // the scroll base added to a content length, so it named a row far below the last one drawn
    // and the copy ran on through every row in between.
    tui.scrollPage(-1);
    await flush();

    const x0 = transcript.lpos.xi + transcript.ileft;
    const contentY = transcript.lpos.yi + transcript.itop;
    // The rows the pane can draw: the content's first row down to the widget's last, less its border.
    const visibleRows = transcript.lpos.yl - 2 - contentY + 1;

    const mouse = (action, x, y) => tui.screen.program.emit('mouse', { x, y, action });
    mouse('mousedown', x0, contentY);
    mouse('mouseup', x0 + 4, transcript.lpos.yl + 8); // released well below the pane
    await flush();

    const saved = clipboardFiles(clipboardDir);
    assert.equal(saved.length, 1, 'the drag saved one file');

    // Compare against the transcript's own rows rather than the composited screen: the copy
    // confirmation is a toast painted over the top row, so the grid reads that where the text is.
    const rowText = (line) => String(line ?? '').replace(/\x1b\[[\d;]*m/g, '').replace(/\s+$/, '');
    const base = transcript.childBase || 0;
    const expected = transcript._clines.slice(base, base + visibleRows).map(rowText);
    assert.equal(expected.length, visibleRows, 'the pane really shows that many rows');

    const rows = saved[0].text.split('\n');
    assert.equal(rows.length, visibleRows, 'the copy covers every row the pane drew and no more');
    assert.deepEqual(rows.slice(0, -1), expected.slice(0, -1), 'every full row is copied whole');
    // The release landed partway along the last row, so that row comes back as a prefix of it —
    // and it is the pane's last row, never one below it.
    assert.ok(
      expected[visibleRows - 1].startsWith(rows[rows.length - 1]),
      'the copy stops on the last drawn row',
    );
  }, { columns: 80, rows: 24 });
});
