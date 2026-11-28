import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sliceCells,
  selectionText,
  pointAt,
  normalizePoint,
  isBefore,
  createTextSelection,
} from '../app/transcript-select.js';
import { drawnRows } from '../app/transcript-geometry.js';

/**
 * The selection *model* (docs/interface/clipboard-selection): a drag is two points, and the
 * text is read out of the lines between them.
 *
 * The other halves live beside this file — the OSC 52 envelope in
 * `tests/clipboard-copy.test.js`, the reverse-video mark in
 * `tests/clipboard-highlight.test.js`, the whole gesture through a real screen in
 * `tests/clipboard-selection-tui.test.js` — because each is a different responsibility and
 * a reader looking for one should not have to walk past the others.
 */

test('sliceCells() takes whole clusters and never cuts a wide glyph in half', () => {
  const line = 'ab👍🏽cd';
  // Cells: a(0) b(1) 👍🏽(2-4) c(4) d(5) — the emoji is two cells wide.
  assert.equal(sliceCells(line, 0, 2), 'ab');
  assert.equal(sliceCells(line, 2, 3), '👍🏽', 'a wide glyph is taken whole from either cell');
  assert.equal(sliceCells(line, 3, 4), '👍🏽');
  assert.equal(sliceCells(line, 2, 4), '👍🏽');
  assert.equal(sliceCells(line, 4, 6), 'cd');
  assert.equal(sliceCells(line, 0, Infinity), line);
  // An empty or inverted range is nothing, never a crash.
  assert.equal(sliceCells(line, 3, 3), '');
  assert.equal(sliceCells(line, 5, 2), '');
  assert.equal(sliceCells('', 0, 4), '');
  assert.equal(sliceCells(null, 0, 4), '');
});

test('selectionText() normalises the drag, joins the rows and drops the band padding', () => {
  // A banded row is padded to the region width: that padding is paint, not text.
  const rows = ['alpha bravo     ', 'charlie delta   ', 'echo foxtrot    '];

  assert.equal(
    selectionText({ rows, anchor: { row: 0, cell: 0 }, focus: { row: 2, cell: 4 } }),
    'alpha bravo\ncharlie delta\necho',
  );
  // Dragging upwards copies the same thing as dragging downwards.
  assert.equal(
    selectionText({ rows, anchor: { row: 2, cell: 4 }, focus: { row: 0, cell: 0 } }),
    'alpha bravo\ncharlie delta\necho',
  );
  // A single-row drag is a slice of that row, and its padding never comes along.
  assert.equal(
    selectionText({ rows, anchor: { row: 0, cell: 6 }, focus: { row: 0, cell: 11 } }),
    'bravo',
  );
  // A missing point is nothing to copy, and a range past the end is clamped away.
  assert.equal(selectionText({ rows, anchor: null, focus: { row: 0, cell: 2 } }), '');
  assert.equal(selectionText({ rows, anchor: { row: 9, cell: 0 }, focus: { row: 9, cell: 2 } }), '');

  assert.deepEqual(normalizePoint({ row: -3, cell: -1 }), { row: 0, cell: 0 });
  assert.equal(normalizePoint({ row: 'x', cell: 0 }), null);
  assert.equal(normalizePoint(null), null);
  assert.equal(isBefore({ row: 0, cell: 5 }, { row: 1, cell: 0 }), true);
  assert.equal(isBefore({ row: 1, cell: 0 }, { row: 0, cell: 5 }), false);
});

test('pointAt() maps a mouse event onto a content point through the widget geometry', () => {
  // ileft/itop are the border plus the padding, exactly as the block click reads them.
  const widget = {
    lpos: { xi: 0, yi: 1 },
    ileft: 2,
    itop: 1,
    childBase: 0,
  };
  assert.deepEqual(pointAt(widget, { x: 5, y: 4 }), { row: 2, cell: 3 });
  // Scrolling moves the content up, so the base is added back.
  assert.deepEqual(pointAt({ ...widget, childBase: 10 }, { x: 5, y: 4 }), { row: 12, cell: 3 });
  // A click above the content clamps to row 0 rather than going negative.
  assert.deepEqual(pointAt(widget, { x: 2, y: 1 }), { row: 0, cell: 0 });
  // No geometry, no point.
  assert.equal(pointAt(null, { x: 1, y: 1 }), null);
  assert.equal(pointAt(widget, null), null);
  assert.equal(pointAt({}, { x: 1, y: 1 }), null);
});

/** A selection over a two-line widget, with every callback recorded. */
function makeSelection() {
  const widget = {
    lpos: { xi: 0, yi: 0 },
    ileft: 0,
    itop: 0,
    childBase: 0,
    _clines: ['alpha bravo', 'charlie delta'],
  };
  const copies = [];
  const notices = [];
  let repaints = 0;
  const selection = createTextSelection({
    widget,
    copy: (text) => {
      copies.push(text);
      return { ok: true, bytes: text.length, truncated: false, chars: text.length, error: null };
    },
    notify: (report, text) => notices.push({ report, text }),
    repaint: () => { repaints += 1; },
  });
  return { selection, copies, notices, get repaints() { return repaints; } };
}

test('createTextSelection() copies on the release, so a drag with no motion still copies', () => {
  const { selection, copies, notices } = makeSelection();

  // The terminal reports the press and the release only: no mousemove in between. The
  // release point is enough to select between them.
  selection.start({ x: 0, y: 0 });
  const done = selection.finish({ x: 5, y: 1 });
  assert.ok(done, 'the release alone finished a selection');
  assert.equal(done.text, 'alpha bravo\ncharl');
  assert.equal(done.report.ok, true);
  assert.deepEqual(copies, ['alpha bravo\ncharl']);
  assert.equal(notices.length, 1, 'the reader is told what happened');
  assert.equal(selection.selection, null, 'the gesture is over');
});

test('finish() clears the selection and repaints, copied or not', () => {
  const harness = makeSelection();
  const { selection, copies } = harness;

  // A plain click — press and release on the same cell — copies nothing but still ends
  // the gesture and still repaints, or a stale band would stay on screen.
  const before = harness.repaints;
  selection.start({ x: 0, y: 0 });
  assert.equal(selection.finish({ x: 0, y: 0 }), null, 'a plain click is not a selection');
  assert.deepEqual(copies, [], 'a plain click copies nothing');
  assert.equal(selection.dragging, false, 'the gesture is over either way');
  assert.ok(harness.repaints > before, 'the band was cleared on screen');

  // A press and release that never moved copies nothing, and is still consumed.
  selection.start({ x: 0, y: 0 });
  selection.move({ x: 0, y: 0 });
  assert.equal(selection.finish(), null);
  assert.equal(copies.length, 0);
});

test('a drag that moves copies on whichever edge finishes it first', () => {
  const { selection, copies } = makeSelection();

  // The motion path: press, move, then finish with no event (the `click` edge).
  selection.start({ x: 0, y: 0 });
  selection.move({ x: 5, y: 1 });
  assert.deepEqual(selection.selection, { anchor: { row: 0, cell: 0 }, focus: { row: 1, cell: 5 } });
  assert.equal(selection.finish().text, 'alpha bravo\ncharl');

  // The second edge for the same gesture finds nothing live and answers null, so a
  // terminal that sends both mouseup and click copies exactly once.
  assert.equal(selection.finish({ x: 5, y: 1 }), null);
  assert.equal(copies.length, 1, 'copied exactly once');

  // Motion without a press is a hover and extends nothing.
  assert.equal(selection.move({ x: 3, y: 0 }), null);
});

test('a second press extends the gesture instead of restarting it', () => {
  // This is how a real drag reaches us: neo-blessed reports motion with a button held as
  // another `mousedown` carrying the new coordinates, never as `mousemove` (see
  // `tests/clipboard-mouse-wire.test.js`). A machine that re-anchored on every press
  // restarted at every drag step and finished with a zero-width range, which is why a drag
  // copied nothing while holding Shift appeared to work.
  const { selection, copies } = makeSelection();

  selection.start({ x: 0, y: 0 });
  selection.start({ x: 4, y: 0 });
  selection.start({ x: 8, y: 0 });
  assert.deepEqual(
    selection.selection,
    { anchor: { row: 0, cell: 0 }, focus: { row: 0, cell: 8 } },
    'the anchor stays at the first press and every later one moves the focus',
  );
  assert.equal(selection.finish().text, 'alpha br', 'the whole drag is copied');
  assert.equal(copies.length, 1);
});

test('cancel() drops a gesture without copying, and clears the band', () => {
  const harness = makeSelection();
  const { selection, copies } = harness;

  selection.start({ x: 0, y: 0 });
  selection.move({ x: 2, y: 0 });
  const before = harness.repaints;
  selection.cancel();
  assert.equal(selection.dragging, false);
  assert.equal(selection.anchor, null);
  assert.equal(copies.length, 0);
  assert.ok(harness.repaints > before, 'the band left the screen');
});

test('contentPoint() clamps into the rows that are drawn, not the rows that exist', () => {
  // The clamp is `drawnRows()`, and it used to be `childBase + _clines.length - 1` — the scroll
  // *base* added to a *content* length, two different spaces. On a scrolled pane that names a row
  // far past the last one that exists (a measured 130 against 79), so a drag released below the
  // pane copied every row in between: text the reader never pointed at and never saw.
  const widget = {
    lpos: { xi: 0, yi: 1, xl: 80, yl: 18 },
    ileft: 2,
    itop: 1,
    childBase: 50,
    height: 17,
    iheight: 2, // 15 content rows on screen, so the last drawn is 50 + 15 - 1 = 64
    _clines: Array.from({ length: 80 }, (_, i) => `row ${i}`),
  };
  assert.equal(drawnRows(widget), 64, 'the last row really painted');
  assert.deepEqual(pointAt(widget, { x: 2, y: 2 }), { row: 50, cell: 0 }, 'the first drawn row');
  // Below the pane: the last row on screen, not the last row that exists and not row 130.
  assert.deepEqual(pointAt(widget, { x: 2, y: 40 }), { row: 64, cell: 0 }, 'clamped to the pane bottom');
  // Above the pane a drag reaches for history, so it stops at the first row on screen rather than
  // running to row 0 — the same mistake in the other direction.
  assert.deepEqual(pointAt(widget, { x: 2, y: 0 }), { row: 50, cell: 0 }, 'clamped to the pane top');
  // No layout: no opinion, and the row is bounded only by zero.
  assert.equal(drawnRows({}), null, 'a widget with no lines has no opinion');
});