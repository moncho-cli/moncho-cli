import { graphemes, graphemeWidth } from './cell-width.js';
import { contentPoint } from './transcript-geometry.js';

/**
 * Selecting text in the conversation with the mouse and copying it on mouse up
 * (task-backlog: "text selection should copy to clipboard whatever was selected right
 * on mouse up, in the conversation section").
 *
 * A terminal's own selection is invisible to the process: the terminal paints it and
 * keeps it, and a program can neither read it nor be told it happened. So the
 * conversation makes the selection itself, in **content coordinates**, and saves the
 * result to a file in the workspace (`app/clipboard-file.js`) — a container has no
 * clipboard to reach, and a file is the medium that needs no display server.
 *
 * The one decision that makes this exact rather than approximate: the rows the user
 * dragged over are **blessed's own wrapped rows**. A display line longer than the
 * region is broken by neo-blessed with rules of its own (it breaks *past* a space, a
 * double-width glyph or a combining mark), so re-deriving that wrapping here would put
 * every copied character a few columns off on exactly the long lines a reader most
 * wants to copy. `contentRows()` instead reads the rows blessed actually wrapped and
 * parsed (`widget._clines`), which is the same table the block click already reads for
 * its row map (`app/transcript.js#blockAtClick`).
 *
 * Coordinates, therefore, are:
 *
 *  - a **row** is an index into those wrapped rows, the same unit `childBase` and
 *    `rtof` are expressed in, so scrolling needs no correction of its own;
 *  - a **cell** is a terminal cell from the content's left edge — `ileft` columns in
 *    from the widget's own left edge, which is the border plus the padding;
 *  - a **point** is `{ row, cell }`, and a selection is two of them.
 *
 * Everything above the widget is pure: the row slicing takes an array of strings, so
 * the extraction is unit tested without a screen.
 */

/** The SGR sequences `_clines` carries: the rows are parsed, not raw text. */
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** One point of a selection, with junk coerced away rather than propagated. */
export function normalizePoint(point) {
  if (!point) return null;
  const row = Number(point.row);
  const cell = Number(point.cell);
  if (!Number.isFinite(row) || !Number.isFinite(cell)) return null;
  return { row: Math.max(0, Math.trunc(row)), cell: Math.max(0, Math.trunc(cell)) };
}

/** True when `a` is at or before `b` in reading order. */
export function isBefore(a, b) {
  if (!a || !b) return false;
  return a.row < b.row || (a.row === b.row && a.cell <= b.cell);
}

/** True when two points name the same cell. */
export function isSamePoint(a, b) {
  return Boolean(a && b) && a.row === b.row && a.cell === b.cell;
}

/**
 * The part of `text` whose cells fall inside the half-open cell range `[from, to)`.
 *
 * The cut is made **between grapheme clusters**, and a cluster is kept when any of its
 * cells is inside the range, so a wide glyph or an emoji is copied whole or not at all
 * — half a `👍🏽` on the clipboard is worse than none. An open range (`to` not finite)
 * runs to the end of the line.
 */
export function sliceCells(text, from = 0, to = Infinity) {
  const start = Math.max(0, Math.trunc(Number(from)) || 0);
  const end = Number.isFinite(to) ? Math.trunc(to) : Infinity;
  if (end <= start) return '';

  const kept = [];
  let cell = 0;
  for (const cluster of graphemes(String(text ?? ''))) {
    const width = graphemeWidth(cluster);
    const clusterStart = cell;
    cell += width;
    if (cell <= start) continue;
    if (clusterStart >= end) break;
    kept.push(cluster);
  }
  return kept.join('');
}

/**
 * The text of a selection: every row between the two points, each cut to the cells the
 * selection covers, joined by newlines.
 *
 * Trailing whitespace is dropped from every copied row. A row of the transcript is
 * padded to the region's width by the prose band, and a band's padding is paint, not
 * text: copying it would put a screenful of spaces on the user's clipboard. The order
 * of the two points is not the caller's problem — the selection is normalised here, so
 * dragging upwards copies the same thing as dragging downwards.
 */
export function selectionText({ rows = [], anchor = null, focus = null } = {}) {
  const start = normalizePoint(anchor);
  const end = normalizePoint(focus);
  if (!start || !end) return '';

  const first = isBefore(start, end) ? start : end;
  const last = isSamePoint(first, start) ? end : start;
  const lines = Array.isArray(rows) ? rows.map((row) => String(row ?? '')) : [];
  if (first.row >= lines.length) return '';

  const out = [];
  for (let row = first.row; row <= last.row; row += 1) {
    if (row < 0 || row >= lines.length) continue;
    const from = row === first.row ? first.cell : 0;
    const to = row === last.row ? last.cell : Infinity;
    out.push(sliceCells(lines[row], from, to).replace(/\s+$/, ''));
  }
  return out.join('\n');
}

/**
 * The rows the mouse named, tag- and colour-stripped, so what is copied is what the
 * reader saw.
 *
 * `widget._clines` is neo-blessed's **real** line table: one entry per line of content,
 * before wrapping. That is deliberately *not* `_clines.fake`, which holds the rows
 * blessed wrapped on screen. A mouse point names a line of content (`delta.y` is mapped
 * to `row` through the scroll base, with no wrapping involved), so indexing the real
 * table is what keeps the copy aligned with the pointer; reading `fake` here put the
 * copied text one line below the one under the cursor whenever a row was wide enough to
 * wrap.
 *
 * A widget that has not rendered yet has no table: the answer is an empty list, never a
 * crash, because a mouse event can arrive before the first paint.
 */
export function contentRows(widget) {
  const lines = widget?._clines;
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => String(line ?? '').replace(ANSI_RE, ''));
}

/**
 * The content point a mouse event names, or null when the event carries no usable
 * geometry.
 *
 * The arithmetic is the block click's, deliberately: the widget's painted origin, the
 * border and padding above and to the left of the content (`itop`/`ileft`), and the
 * scroll base `childBase` — the same three numbers `app/transcript.js#clickRow` uses, so
 * a click and a drag can never disagree about which row they are on.
 */
export function pointAt(widget, data) {
  return normalizePoint(contentPoint(widget, data));
}

/**
   * The mouse gesture: press, drag, release.
   *
   * The binding is the pane's (`app/tui-transcript.js`). It forwards `mousedown`,
   * `mousemove` and `mouseup` here, and ends a gesture on the first of `mouseup` or the
   * `click` blessed emits for the same press, whichever arrives first.
   *
   * Three details of neo-blessed decide the shape of this machine, and all three cost a
   * working version to learn:
   *
   * 1. **A drag arrives as repeated `mousedown`, never as `mousemove`.** blessed's decoder
   *    recognises motion only from the *no-button* report codes (`program.js#_bindMouse`:
   *    `b === 35 || 39 || 51 || 43`), and a real drag carries the button bit (32 for the
   *    left button, in the SGR encoding a modern terminal sends), so it falls through to
   *    `action = 'mousedown'` — with the *new* coordinates. That is why a press while a
   *    gesture is already live must **extend** it: a machine that re-anchored on every
   *    `mousedown` restarted the selection at every drag step and finished with a
   *    zero-width range, so a drag copied nothing. Holding Shift made it work only because
   *    Shift adds 4 to the code and 39 happens to be in blessed's motion list — the
   *    workaround was a symptom, not a fix.
   * 2. **`mousemove` is a hover.** The only motion blessed reports this way is a pointer
   *    moving with no button held, which must not select: `move()` ignores it unless a
   *    gesture is live.
   * 3. **`click` fires before `mouseup`** (`screen.js#_listenMouse` emits the click at the
   *    `mouseup` report, then the action), so both edges finish a gesture and the second
   *    one finds nothing live and answers null — a terminal that sends both still copies
   *    exactly once.
   *
   * The rule that keeps the block toggle alive is the point of the machine: a gesture that
   * never moved is **not** a selection. `finish()` answers null, the pane falls through to
   * `clickAt()`, and a plain click still expands a tool result. A gesture that did move
   * copies and consumes the click, so dragging across a collapsed block copies its header
   * instead of toggling it.
   *
   * `copy` is the file writer (`app/clipboard-file.js#createClipboardFile`), injected so the
   * whole gesture is exercised without touching a directory; `notify` is told what happened,
   * so the reader learns where the selection was saved, and the two are separate because a
   * copy can succeed with nothing to announce (a test) or fail with something to say.
   *
   * `repaint` is called whenever the band changes and when the gesture ends: the band has to
   * follow the pointer during the drag and disappear on release, and the selection is
   * cleared at that same moment so the next gesture starts clean.
   */
  export function createTextSelection({
    widget = null, copy = null, notify = null, repaint = null,
  } = {}) {
    let anchor = null;
    let focus = null;
    let dragging = false;

    /** The live range, or null while the gesture is still a plain click. */
    const range = () => (
      dragging && anchor && focus && !isSamePoint(anchor, focus) ? { anchor, focus } : null
    );

    const reset = () => {
      anchor = null;
      focus = null;
      dragging = false;
    };

    /** Repaint in place, so the band tracks the pointer and leaves without a scroll. */
    const after = () => {
      if (typeof repaint === 'function') repaint();
    };

    return {
      /**
       * A press: `mousedown`. The **first** press of a gesture anchors it; every later one
       * is a drag step that extends it, which is how a real drag reaches us (see above).
       *
       * Returns the point the press landed on, or null when the event carried no geometry.
       */
      start(data) {
        const point = pointAt(widget, data);
        if (!point) return null;
        if (!dragging) {
          anchor = point;
          dragging = true;
        }
        focus = point;
        return point;
      },
      /**
       * Real motion — a hover, since blessed only reports the no-button case this way.
       * Extends a live gesture and is ignored entirely when no button is held, which is
       * what keeps a bare pointer crossing the conversation from selecting anything.
       */
      move(data) {
        if (!dragging) return null;
        const point = pointAt(widget, data);
        if (!point) return null;
        focus = point;
        return point;
      },
    /**
     * The release: finish the gesture, copy what was selected and answer what was copied
     * (null when the gesture was a plain click, so nothing was selected or copied).
     *
     * `data` is the release event when the caller has one. Taking the point from it is
     * what makes a drag work on a terminal that reports no motion while the button is
     * held; without it the last point `move()` saw is used, which is the same cell on a
     * terminal that does report motion.
     *
     * The selection is **always cleared**, copied or not: the band must not outlive the
     * release, and the next press has to start from a clean state.
     */
    finish(data = null) {
      if (data) {
        const point = pointAt(widget, data);
        if (point) focus = point;
      }
      const live = range();
      reset();
      after();
      if (!live) return null;

      const text = selectionText({ rows: contentRows(widget), ...live });
      if (!text) return null;

      const report = typeof copy === 'function' ? copy(text) : null;
      if (typeof notify === 'function') notify(report, text);
      return { text, report, ...live };
    },
    /** Drop the gesture without copying (a teardown, a lost screen). */
    cancel() {
      reset();
      after();
    },
    /** The gesture in flight, for the pane and the tests. */
    get anchor() {
      return anchor;
    },
    get focus() {
      return focus;
    },
    get dragging() {
      return dragging;
    },
    /** The live range, or null while nothing is selected. */
    get selection() {
      return range();
    },
  };
}
