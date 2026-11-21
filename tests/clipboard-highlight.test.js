import test from 'node:test';
import assert from 'node:assert/strict';

import {
  highlightCells,
  selectionRange,
  lineCellRange,
  highlightRows,
  wrapWidthOf,
  SELECTION_TAG_OPEN,
  SELECTION_TAG_CLOSE,
} from '../app/transcript-highlight.js';

/**
 * The reverse-video mark (docs/interface/clipboard-selection): exactly the cells that will
 * be copied, spliced at a *cell* boundary through the line's own tags, and a line with no
 * selection left byte-for-byte.
 */

test("highlightCells() marks exactly the selected cells through the line's own tags", () => {
  // The tags cost no cells, so the mark lands on the cell boundary, not the byte offset.
  const tagged = '{blue-bg}{cyan-fg}You:{/cyan-fg} hello there{/blue-bg}';
  assert.equal(
    highlightCells(tagged, 0, 4),
    `{blue-bg}{cyan-fg}${SELECTION_TAG_OPEN}You:{/cyan-fg}${SELECTION_TAG_CLOSE} hello there{/blue-bg}`,
  );
  // A mark that runs to the end of the line is closed before returning.
  const openEnded = highlightCells('abc', 1, Infinity);
  assert.equal(openEnded, `a${SELECTION_TAG_OPEN}bc${SELECTION_TAG_CLOSE}`);

  // An empty or inverted range leaves the line byte-for-byte.
  assert.equal(highlightCells('abc', 2, 2), 'abc');
  assert.equal(highlightCells('abc', 5, 1), 'abc');

  // A wide glyph is marked whole when either of its cells is inside the range.
  assert.equal(
    highlightCells('a👍🏽b', 1, 2),
    `a${SELECTION_TAG_OPEN}👍🏽${SELECTION_TAG_CLOSE}b`,
  );

  // An escaped brace is one cell of text, not a tag: the mark after it stays aligned.
  assert.equal(
    highlightCells('{open}ab', 1, 2),
    `{open}${SELECTION_TAG_OPEN}a${SELECTION_TAG_CLOSE}b`,
  );
});

test('lineCellRange() maps a wrapped-row range onto one display line', () => {
  // A display line wrapped into rows 3, 4, 5 at width 10, so row 4 starts at cell 10.
  const rows = [3, 4, 5];
  assert.deepEqual(
    lineCellRange({ rows, first: { row: 4, cell: 2 }, last: { row: 4, cell: 5 }, width: 10 }),
    { from: 12, to: 15 },
  );
  // A range reaching this line from an earlier row starts at the line's own edge.
  assert.deepEqual(
    lineCellRange({ rows, first: { row: 0, cell: 0 }, last: { row: 4, cell: 5 }, width: 10 }),
    { from: 0, to: 15 },
  );
  // ... and one leaving for a later row runs to the end of this line.
  assert.deepEqual(
    lineCellRange({ rows, first: { row: 5, cell: 2 }, last: { row: 9, cell: 0 }, width: 10 }),
    { from: 22, to: Infinity },
  );
  // A range that does not reach this line is null, and an empty one too.
  assert.equal(lineCellRange({ rows, first: { row: 9, cell: 0 }, last: { row: 9, cell: 5 }, width: 10 }), null);
  assert.equal(lineCellRange({ rows, first: { row: 3, cell: 4 }, last: { row: 3, cell: 4 }, width: 10 }), null);
  assert.equal(lineCellRange({ rows: [], first: { row: 0, cell: 0 }, last: { row: 1, cell: 0 } }), null);
});

test("highlightRows() reads blessed's own row table and leaves other lines untouched", () => {
  // Two display lines; the second wrapped into three rows (1, 2, 3) at width 5.
  const lines = ['short', 'long line that wrapped'];
  const ftor = [[0], [1, 2, 3]];
  const marked = highlightRows({
    lines,
    anchor: { row: 2, cell: 1 },
    focus: { row: 2, cell: 3 },
    ftor,
    width: 5,
  });

  assert.equal(marked[0], 'short', 'a line with no selection comes back byte-for-byte');
  // Row 2 is the second wrapped row, so its cell 1 is cell 6 of the line.
  assert.equal(marked[1], `long l${SELECTION_TAG_OPEN}in${SELECTION_TAG_CLOSE}e that wrapped`);

  // Without blessed's table nothing can be located, so nothing is marked.
  assert.deepEqual(highlightRows({ lines, anchor: { row: 0, cell: 0 }, focus: { row: 1, cell: 2 }, ftor: null }), lines);
  // No selection at all is the same list.
  assert.deepEqual(highlightRows({ lines, anchor: null, focus: null, ftor }), lines);

  assert.equal(selectionRange({ row: 0, cell: 0 }, { row: 0, cell: 0 }), null, 'a zero-width drag is no selection');
  assert.deepEqual(
    selectionRange({ row: 2, cell: 1 }, { row: 0, cell: 0 }),
    { first: { row: 0, cell: 0 }, last: { row: 2, cell: 1 } },
    'the range is normalised to reading order',
  );
  assert.equal(wrapWidthOf(null), 0);
});
