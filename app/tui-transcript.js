import { createTranscriptView } from './transcript-view.js';
import { createTextSelection } from './transcript-select.js';
import { bindSelectionGestures } from './transcript-mouse.js';
import { highlightRows, wrapWidthOf } from './transcript-highlight.js';
import { createPaintCoalescer } from './paint-coalescer.js';
import { nativeSelectionEnabled } from '../config/constants.js';

/**
 * The transcript *pane*: the model+view pair, the click that toggles a tool-result
 * block, and the four operations the rest of the screen asks of it (append prose,
 * append a collapsible block, scroll by rows, page).
 *
 * Extracted from `app/tui.js`, which was at its line budget: what stays there is
 * the *wiring* of the screen (which regions exist, which keys they answer), and
 * what lands here is the one region that owns a model of its own. The pane is the
 * seam the host talks to, so `app/tui.js` never reaches into the view.
 *
 * `stamp` is the per-entry timestamp hook (`app/transcript-stamp.js`): the TUI
 * passes `createStamper()` and the pane marks every entry it appends with the time
 * it appeared. The mark is display only — it never reaches a chunk or a session
 * file — and `setStamping(false)` turns it off while a stored conversation is
 * replayed, because those rows appeared in a past run.
 */
export function createTranscriptPane({
  transcript, refresh = () => {}, stamp = null, copy = null, notify = null, screen = null,
  // Called after every paint and every move of the view. The pinned user message is the
  // one thing on screen whose *presence* depends on the offset, so it re-reads from here
  // (`app/sticky-bar.js`); absent in a front end with no such row.
  onPaint = null,
  // Whether the terminal keeps the mouse (`docs/interface/clipboard-selection`). `null` asks
  // the environment; `app/tui.js` passes its own answer so one decision covers the screen.
  nativeSelection = null,
} = {}) {
  // The mouse selection (docs/interface/clipboard-selection). It is created before the
  // view because the view paints *through* it: the decorator below is the one hook that
  // lets a selection mark the composed lines without the view knowing what a selection
  // is. `copy` is the clipboard writer and `notify` the sink told what happened — both
  // injected, so a test drives a whole drag with neither a terminal nor a clipboard.
  // `repaint` is late-bound: the selection outlives no one, but the view is built below
  // it, and ending a gesture has to *clear the band* on screen.
  const selection = createTextSelection({
    widget: transcript,
    copy,
    notify,
    repaint: () => view.repaintInPlace(),
  });

  // A drag step's band repaint is coalesced to one paint per turn (app/paint-coalescer.js).
  // A fast drag arrives as a burst of reports decoded in a single turn, and one paint per
  // report re-renders the whole conversation each time — the lag a long transcript shows.
  // The release bypasses it and cancels it (app/transcript-mouse.js#onUp).
  const bandPaint = createPaintCoalescer({ paint: () => view.repaintInPlace() });

  // When the terminal owns the mouse — the default, `NATIVE_SELECTION_ENABLED`
  // (docs/interface/clipboard-selection) — no report ever reaches this program, so the band
  // decorator, the click and the gesture bindings are not installed at all. Binding them
  // would be dead code *and* would arm blessed's mouse dispatcher, whose whole job is to
  // negotiate the protocol the default avoids (`app/tui-screen.js`).
  const nativeMouse = nativeSelection === null ? nativeSelectionEnabled() : Boolean(nativeSelection);

  const decorate = nativeMouse ? null : (content, widget) => highlightRows({
    lines: String(content ?? '').split('\n'),
    anchor: selection.anchor,
    focus: selection.focus,
    // blessed's own real->fake table and the width it really wrapped at, so the mark
    // lands on the rows the mouse named (app/transcript-highlight.js). The table is the
    // one from the *previous* paint, which is the same wrapping: the decorator only ever
    // inserts tags, and tags cost no cells, so the rows a line breaks into are invariant
    // under the highlight and the table cannot go stale.
    ftor: widget?._clines?.ftor ?? null,
    width: wrapWidthOf(widget),
  }).join('\n');

  const view = createTranscriptView({ widget: transcript, refresh, stamp, decorate, onPaint });

  // A click on the transcript finishes a mouse gesture before it means anything else:
  // a drag copies the selection and consumes the click, a plain click falls through to
  // the tool-result toggle below, so the two behaviours share one event without racing.
  // The release normally finishes the gesture first (app/transcript-mouse.js binds
  // `mouseup` for the terminals that report no motion), and `finish()` on an already
  // finished gesture answers null, so this is the fallback rather than the primary path.
  if (!nativeMouse && typeof transcript?.on === 'function') {
    transcript.on('click', (data) => {
      // The block the gesture ended on, or null when the drag copied instead. The value
      // is returned rather than dropped: the pane's click handler is the same seam it
      // always was, and `clickTranscript()` reports what it resolved to.
      if (selection.finish(data)) return null;
      return view.clickAt(data);
    });
  }

  // Press, motion and release drive the gesture; each repaints in place, because the band
  // has to follow the pointer mid-drag and leave the screen on release. The **release is
  // bound on the screen**, not here: blessed hit-tests each report and only emits to the
  // element the pointer is over, so a button released outside this pane is answered by
  // whatever region it is over and never reaches the transcript — while the screen
  // re-emits every report. Bound to the widget alone, a drag that left the pane stayed
  // stuck as a held press (app/transcript-mouse.js#bindSelectionGestures).
  const gestures = nativeMouse ? null : bindSelectionGestures({
    widget: transcript,
    screen,
    selection,
    repaint: () => view.repaintInPlace(),
    repaintSoon: bandPaint,
  });

  return {
    view,
    /** Append plain text (prose, notices, tool-call headers, the user echo). */
    log: (...args) => view.log(...args),
    /**
     * Append one side of the dialogue with its background band: the user's echoed
     * prompt or the model's prose (`docs/interface/prose-bands`).
     */
    logProse: (role, text) => view.logProse(role, text),
    /**
     * Append a tool result as a collapsible block: one header line carrying the
     * "X char response" size, expanded by a click.
     */
    logBlock: (options) => view.logBlock(options),
    /** Scroll by rows (the wheel and the keyboard move the same distances). */
    scrollBy: (amount) => view.scrollRows(amount),
    /** Page towards the bottom (`direction < 0` pages up), one screenful minus one. */
    scrollPage: (direction) => view.scrollPage(direction),
    /** Drop every entry (resuming a session replaces the whole transcript). */
    clear: () => view.clear(),
    /** Turn the per-entry timestamps off while a stored conversation is replayed. */
    setStamping: (value) => view.setStamping(value),
    /** The mouse selection and the gesture behind it (docs/interface/clipboard-selection). */
    selection,
    get selectionRange() {
      return selection.selection;
    },
    get model() {
      return view.model;
    },
    get content() {
      return view.content;
    },
    close: () => {
      gestures?.dispose();
      bandPaint.cancel();
      view.close();
    },
  };
}
