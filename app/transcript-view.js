import { TranscriptModel, blockAtClick } from './transcript.js';
import { formatArg, formatTranscript } from './tui-render.js';
import {
  FOLLOW_BOTTOM_PERCENT,
  WHEEL_STEP_ROWS,
  pageStepRows,
  isFollowingScroll,
} from './transcript-scroll.js';

// The pure half (the follow/hold rule and the gesture steps) lives in
// ./transcript-scroll.js so this module stays under the line budget; it is
// re-exported here, because this is the path every importer already uses.
export { FOLLOW_BOTTOM_PERCENT, WHEEL_STEP_ROWS, pageStepRows, isFollowingScroll };

/**
 * Bind a TranscriptModel to a blessed scrollable widget.
 *
 * The widget is the *view*: every repaint derives its content from the model, so
 * toggling a block is just a model change followed by a repaint — the payload can
 * never be lost. Rendering (sanitising, tag escaping, markdown colouring) happens
 * here, in `formatTranscript()`, so the model stays plain text.
 *
 * `stamp` is the timestamp hook every appended entry is marked with
 * (app/transcript-stamp.js): the TUI passes `createStamper()`, a test a frozen
 * date, and the default `null` marks nothing, which is what the pure view tests
 * want. The mark is stored on the entry, so a repaint paints the same one.
 */
export function createTranscriptView({ widget, refresh = () => {}, stamp = null } = {}) {
  const model = new TranscriptModel();
  let closed = false;
  const stampOf = typeof stamp === 'function' ? stamp : () => null;
  // Switched off while a stored conversation is replayed: those rows appeared in a
  // past run, so marking them with the reload time would state something false.
  let stamping = true;
  const mark = () => (stamping ? stampOf() : null);

  /** One display-ready line list from raw text (sanitised + markdown-coloured). */
  const formatLines = (text) => formatTranscript(text).split('\n');

  const scrollOffset = () => (typeof widget?.getScroll === 'function' ? widget.getScroll() : 0);

  /** Rows of content visible at once, as far as the widget can tell us. */
  const visibleHeight = () => {
    if (!widget) return 0;
    const height = Number(widget.height) || 0;
    const inner = Number(widget.iheight) || 0;
    return height > 0 ? Math.max(0, height - inner) : 0;
  };

  /** Total scrollable height in rows (blessed's getScrollHeight()). */
  const scrollHeight = () => {
    if (!widget) return 0;
    if (typeof widget.getScrollHeight === 'function') return Number(widget.getScrollHeight()) || 0;
    return (Number(widget.childBase) || 0) + visibleHeight();
  };

  /**
   * Is the transcript parked at the bottom right now? (see isFollowingScroll)
   *
   * The offset itself is the source of truth, not blessed's internal
   * `_userScrolled` latch: the widget reaches the very end by several routes
   * (End, mouse, resize) and the latch cannot be trusted to track them all.
   * Before the first layout there is no geometry, and following is the safe
   * answer: nothing has been scrolled away yet.
   */
  const following = () => {
    if (!widget || !widget.lpos) return true;
    return isFollowingScroll({
      percent: typeof widget.getScrollPerc === 'function' ? widget.getScrollPerc() : 0,
      scrollHeight: scrollHeight(),
      visibleHeight: visibleHeight(),
    });
  };

  /**
   * Repaint the widget from the model.
   *
   * An append follows the conversation only when the view was already parked at
   * the bottom ("conversation jumps to the bottom when a message arrives, it
   * should not"): a reader who scrolled up keeps the offset they chose. That is
   * the same hold a block toggle takes, so both go through `keepScroll`.
   *
   * `keepScroll: true` forces the hold; `keepScroll: false` forces the follow.
   * Left undefined, the rule above decides.
   */
  const paint = ({ keepScroll } = {}) => {
    if (closed || !widget) return false;
    const hold = keepScroll === undefined ? !following() : Boolean(keepScroll);
    const offset = scrollOffset();

    /** Put the view exactly where this repaint decided it belongs. */
    const apply = () => {
      if (hold) widget.setScroll(offset);
      else widget.setScrollPerc(100);
    };

    // The view owns the scroll position. blessed's log widget would jump to the
    // bottom on every 'set content' — precisely the behaviour this fixes — so its
    // auto-jump stays suppressed (`_userScrolled` left raised) and apply() below
    // is the only thing that moves the view.
    widget._userScrolled = true;
    widget.setContent(model.content);
    apply();

    // blessed's handlers run on their own tick, so re-assert the decision there:
    // the last paint is the one that wins, whatever order they run in.
    setImmediate(() => {
      if (closed || !widget) return;
      apply();
    });

    refresh();
    return true;
  };

  /**
   * Move the view by `delta` rows (positive = towards the bottom), clamped to
   * the content. Returns true when the view actually moved.
   *
   * A scroll is **not** a repaint: the content is untouched, so blessed only
   * has to move the viewport instead of re-parsing every line. Rebuilding the
   * content on every step is what makes a wheel notch feel like a stutter, so
   * the scroll path never calls `setContent()`.
   */
  const scrollRows = (delta) => {
    if (closed || !widget || typeof widget.scroll !== 'function') return false;
    const step = Math.trunc(Number(delta) || 0);
    if (step === 0) return false;
    const before = Number(widget.childBase) || 0;
    // blessed clamps at both ends itself, so the view can never be scrolled
    // past the first or the last row.
    widget.scroll(step);
    const moved = (Number(widget.childBase) || 0) !== before;
    if (moved) refresh();
    return moved;
  };

  /**
   * Move a whole screenful: `direction > 0` pages towards the bottom.
   *
   * The step is `pageStepRows()`, one row short of the screenful, so the last
   * row of the previous page is the first row of the next one and a reader
   * paging through a long result never skips a line.
   */
  const scrollPage = (direction = 1) => {
    const sign = Number(direction) < 0 ? -1 : 1;
    return scrollRows(sign * pageStepRows(visibleHeight()));
  };

  // The mouse wheel nudges the view a few rows per notch. The handlers are
  // ours rather than blessed's `mouse: true` ones: that option also installs
  // a half-screen wheel step and scrollbar dragging, and this widget's click
  // is already taken by the block toggle.
  const wheelUp = () => { scrollRows(-WHEEL_STEP_ROWS); };
  const wheelDown = () => { scrollRows(WHEEL_STEP_ROWS); };
  const canListen = typeof widget?.on === 'function' && typeof widget?.removeListener === 'function';
  if (canListen) {
    widget.on('wheelup', wheelUp);
    widget.on('wheeldown', wheelDown);
  }

  /** Append plain text (prose, notices, tool call headers). */
  const log = (...args) => {
    const text = args.map(formatArg).join(' ');
    const lines = formatLines(text);
    // One mark per entry, on its first line that is not blank: a reply spanning ten
    // lines is stamped once, so a long answer never becomes a column of identical
    // times, and an entry that opens with a blank line (the `\n  [tool Output]`
    // shape main.js builds) is stamped where its text really starts.
    const first = lines.findIndex((line) => String(line).trim() !== '');
    lines.forEach((line, index) => {
      model.addLine(line, { stamp: index === first ? mark() : null });
    });
    return paint();
  };

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
  const logBlock = ({ header = '', body = '', collapsed = null, bodyColor = null } = {}) => {
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
      stamp: mark(),
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

  return {
    model,
    log,
    logBlock,
    toggleBlock,
    expandBlock,
    collapseBlock,
    clickAt,
    clear,
    paint,
    scrollRows,
    scrollPage,
    /** Turn the per-entry timestamps on or off (a session reload marks nothing). */
    setStamping(value) {
      stamping = value !== false;
      return stamping;
    },
    /** True while new output follows the bottom of the transcript. */
    isFollowing: following,
    close() {
      closed = true;
      if (canListen) {
        widget.removeListener('wheelup', wheelUp);
        widget.removeListener('wheeldown', wheelDown);
      }
    },
    get content() {
      return model.content;
    },
  };
}
