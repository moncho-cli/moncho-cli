import { TranscriptModel, blockAtClick } from './transcript.js';
import { formatArg, formatTranscript } from './tui-render.js';
import { bandWidthOf, composeBanded, takeBandOptions } from './prose-band.js';
import { appendLines } from './transcript-append.js';
import { STAMP_RE } from './transcript-stamp.js';
import { createViewport } from './transcript-viewport.js';

// The follow/hold rule, the gesture steps and the wheel live in
// ./transcript-scroll.js (pure) and ./transcript-viewport.js (the widget binding), so
// this module stays the model binding; the vocabulary is re-exported here because this
// is the path every importer already uses.
export {
  FOLLOW_BOTTOM_PERCENT,
  WHEEL_STEP_ROWS,
  pageStepRows,
  isFollowingScroll,
} from './transcript-viewport.js';

/**
 * Bind a TranscriptModel to a blessed scrollable widget.
 *
 * The widget is the *view*: every repaint derives its content from the model, so
 * toggling a block is just a model change followed by a repaint — the payload can
 * never be lost. Rendering (sanitising, tag escaping, markdown colouring) happens
 * here, in `formatTranscript()`, so the model stays plain text.
 *
 * Where the view *is* — the follow decision, the scroll steps, the wheel — is
 * `createViewport()` (`app/transcript-viewport.js`): a different responsibility, and the
 * only one that is about geometry rather than about what the conversation says.
 *
 * `stamp` is the timestamp hook every appended entry is marked with
 * (app/transcript-stamp.js): the TUI passes `createStamper()`, a test a frozen
 * date, and the default `null` marks nothing, which is what the pure view tests
 * want. The mark is stored on the entry, so a repaint paints the same one.
 *
 * `decorate` is the one hook through which something outside the view can mark the
 * composed lines — the mouse selection paints its reverse-video band with it
 * (`app/transcript-highlight.js`). It is called with the *banded* lines and the widget,
 * and must return lines of the same count: the row map the block click reads is built
 * from the wrapping of what is handed to the widget, so a decorator that changed the
 * number of lines would move every block under the cursor. The default `null` is no
 * decorator at all.
 */
export function createTranscriptView({
  widget, refresh = () => {}, stamp = null, decorate = null,
} = {}) {
  const model = new TranscriptModel();
  let closed = false;
  const markLines = typeof decorate === 'function' ? decorate : null;
  // Depth of the bulk-append suspension (see `bulk()` below): while it is above zero
  // `paint()` returns without re-rendering, and the outermost `bulk()` paints once.
  let suspended = 0;
  const stampOf = typeof stamp === 'function' ? stamp : () => null;
  // Switched off while a stored conversation is replayed without stored times: those
  // rows appeared in a past run, so marking them with the reload time would state
  // something false. A replay that *has* the stored times passes each one explicitly
  // (the `{ stamp }` option below), so the record's own clock is what gets painted
  // (`docs/interface/session-stamps`).
  let stamping = true;
  const mark = () => (stamping ? stampOf() : null);
  /** The mark for one entry: an explicit stored time first, the clock otherwise. */
  const markFor = (stamp) => {
    const explicit = typeof stamp === 'string' && STAMP_RE.test(`${stamp} `) ? stamp : null;
    return explicit ?? mark();
  };

  /** One display-ready line list from raw text (sanitised + markdown-coloured). */
  const formatLines = (text) => formatTranscript(text).split('\n');

  const viewport = createViewport({ widget, repaint: () => refresh() });

  /**
   * Repaint the widget from the model.
   *
   * An append follows the conversation only when the view was already parked at
   * the bottom ("conversation jumps to the bottom when a message arrives, it
   * should not"): a reader who scrolled up keeps the offset they chose. That is
   * the same hold a block toggle takes, so both go through `keepScroll`.
   *
   * `keepScroll: true` forces the hold; `keepScroll: false` forces the follow.
   * Left undefined, the viewport's own rule decides.
   */
  const paint = ({ keepScroll } = {}) => {
    if (closed || !widget) return false;
    // A bulk append suspends the repaint: painting once per entry re-renders the
    // transcript as it grows, so N appends cost O(N^2) — which is where replaying a
    // large session spent its seconds (`bulk()` below paints once at the end).
    if (suspended > 0) return false;

    // The view owns the scroll position. blessed's log widget would jump to the
    // bottom on every 'set content' — precisely the behaviour this fixes — so its
    // auto-jump stays suppressed (`_userScrolled` left raised) and the viewport is
    // the only thing that moves the view.
    widget._userScrolled = true;
    // The decision is taken *before* the content changes: the rule asks whether the
    // reader is at the bottom, and a widget handed more lines is no longer at the same
    // bottom — deciding afterwards would read every append as "the reader scrolled up"
    // and freeze a view that was following.
    const settle = viewport.decide({ keepScroll });
    // The band is a full-width background, so the width is resolved here, at paint
    // time, instead of being baked into a line (app/prose-band.js). A row whose role
    // has no band comes back byte-for-byte.
    const banded = composeBanded(model.lineRecords(), bandWidthOf(widget));
    widget.setContent(markLines ? markLines(banded, widget) : banded);
    settle();

    // blessed's handlers run on their own tick, so re-assert the decision there:
    // the last paint is the one that wins, whatever order they run in.
    setImmediate(() => {
      if (closed || !widget) return;
      settle();
    });

    refresh();
    return true;
  };

  /**
   * Append plain text (prose, notices, tool call headers).
   *
   * A trailing `{ role }` marks the entry as one side of the dialogue and paints it
   * with that side's background band, with one blank banded row above and below it
   * (`docs/interface/prose-bands`); without one the entry is exactly what it always
   * was. The margins and the stamp belong to `appendLines()`
   * (app/transcript-append.js), so this stays the widget binding.
   */
  const log = (...args) => {
    const { role = null, stamp = null } = takeBandOptions(args);
    const text = args.map(formatArg).join(' ');
    appendLines(model, formatLines(text), { role, mark: () => markFor(stamp) });
    return paint();
  };

  /**
   * Append one side of the dialogue as a background-banded entry: the band, plus its
   * blank top and bottom margin (`docs/interface/prose-bands`).
   */
  const logProse = (role, text, { stamp = null } = {}) => log(text, { role, stamp });

  /**
   * Append a collapsible block. `header` is the one-line label the block keeps
   * when collapsed (the "X char response" size is appended by the model) and
   * `body` is the payload, stored verbatim so expanding is lossless.
   *
   * `bodyColor` paints the whole payload in one blessed colour — a tool result keeps the
   * markdown colours it was rendered with (the default, `null`), while the tracking content
   * block asks for the tracking colour so the file it quotes reads as a milestone
   * rather than as an ordinary tool result (`docs/interface/tracking-block`).
   */
  const logBlock = ({ header = '', body = '', collapsed = null, bodyColor = null, stamp = null } = {}) => {
    const source = String(body ?? '');
    const colour = typeof bodyColor === 'string' && bodyColor ? bodyColor : null;
    const bodyLines = formatLines(source).map((line) => (
      colour && String(line).trim() !== '' ? `{${colour}-fg}${line}{/${colour}-fg}` : line
    ));
    const block = model.addBlock({
      header: formatLines(header).join(' '),
      body: source,
      bodyLines,
      collapsed,
      stamp: markFor(stamp),
    });
    paint();
    return block;
  };

  const toggleBlock = (id) => {
    const block = model.toggleBlock(id);
    if (block) paint({ keepScroll: true });
    return block;
  };

  const expandBlock = (id) => {
    const block = model.expandBlock(id);
    if (block) paint({ keepScroll: true });
    return block;
  };

  const collapseBlock = (id) => {
    const block = model.collapseBlock(id);
    if (block) paint({ keepScroll: true });
    return block;
  };

  /**
   * Click handler: resolve the clicked row to a block (through the widget's
   * wrapped-line map) and toggle it. Returns the block, or null when the click
   * did not land on one.
   */
  const clickAt = (data) => {
    if (closed || !widget || !data) return null;
    const block = blockAtClick({
      model,
      data,
      pos: widget.lpos,
      childBase: widget.childBase || 0,
      itop: widget.itop || 0,
      rtof: widget._clines && widget._clines.rtof,
    });
    if (!block) return null;
    return toggleBlock(block.id);
  };

  /**
   * Drop every entry, so a whole conversation can be reloaded in its place
   * (resuming a session). The view follows again from here, so the reloaded
   * conversation ends parked at its newest line — where the live one was left.
   */
  const clear = () => {
    model.clear();
    return paint({ keepScroll: false });
  };

  /**
   * Run `fn` with the per-append repaint suspended, then repaint once.
   *
   * Every append repaints the whole transcript: the model is re-rendered and handed to
   * the widget in full. Replaying a stored conversation one entry at a time therefore
   * re-renders a transcript that is still growing — N appends cost O(N^2), which is
   * where a large session's load time went (the entries themselves and the chunks were
   * milliseconds; the repaints were seconds). Suspending the repaint for the whole
   * replay and painting once at the end makes it O(N) without changing a single line of
   * what is drawn.
   *
   * The one paint follows the bottom, which is where the unpainted appends would have
   * left it: a reload is not a scroll, and the reloaded conversation ends parked at its
   * newest line. Nesting is allowed and only the outermost call paints.
   */
  const bulk = (fn) => {
    suspended += 1;
    try {
      return typeof fn === 'function' ? fn() : undefined;
    } finally {
      suspended -= 1;
      if (suspended === 0) paint({ keepScroll: false });
    }
  };

  return {
    model,
    log,
    logProse,
    logBlock,
    toggleBlock,
    expandBlock,
    collapseBlock,
    clickAt,
    clear,
    bulk,
    paint,
    /** Move the view by rows (positive = towards the bottom), clamped to the content. */
    scrollRows: (delta) => viewport.scrollRows(delta),
    /** Move a whole screenful (`direction < 0` pages up), one row short of the screenful. */
    scrollPage: (direction) => viewport.scrollPage(direction),
    /**
     * A paint that re-reads the model and hands the widget the decorated lines, without
     * moving the view.
     *
     * The pane calls it after a gesture changed the selection: the content is the same
     * and the reader is mid-drag, so a scroll would fight the pointer and the offset the
     * gesture was measured against.
     */
    repaintInPlace() {
      return paint({ keepScroll: true });
    },
    /** Turn the per-entry timestamps on or off (a session reload marks nothing). */
    setStamping(value) {
      stamping = value !== false;
      return stamping;
    },
    /** True while new output follows the bottom of the transcript. */
    isFollowing: () => viewport.following(),
    close() {
      closed = true;
      viewport.close();
    },
    get content() {
      return model.content;
    },
  };
}
