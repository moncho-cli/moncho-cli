import { TranscriptModel, blockAtClick } from './transcript.js';
import { formatArg, formatTranscript } from './tui-render.js';

/**
 * Scroll percentage that still counts as "at the bottom". blessed positions the
 * view to the very end (100) when the user presses End or the mouse reaches the
 * bottom bar, so a small tolerance absorbs a one-row rounding difference.
 */
export const FOLLOW_BOTTOM_PERCENT = 99.5;

/**
 * The follow/hold rule, as pure arithmetic: may an arriving message scroll the
 * transcript to the bottom?
 *
 * - **follow** when the view is parked at the bottom, so new output comes into
 *   sight as it arrives;
 * - **hold** when the user scrolled up to read history: the offset they chose
 *   must survive the append;
 * - **follow** when there is nothing to scroll yet (an unmeasured widget, or
 *   content that already fits), so a short transcript keeps following.
 *
 * @param {object} state
 * @param {number} state.percent        scroll position, 0..100
 * @param {number} state.scrollHeight   scrollable height in rows
 * @param {number} state.visibleHeight  rows of content on screen at once
 */
export function isFollowingScroll({ percent = 0, scrollHeight = 0, visibleHeight = 0 } = {}) {
  const height = Number(visibleHeight) || 0;
  const total = Number(scrollHeight) || 0;
  if (height <= 0 || total <= height) return true;
  return (Number(percent) || 0) >= FOLLOW_BOTTOM_PERCENT;
}

/**
 * Bind a TranscriptModel to a blessed scrollable widget.
 *
 * The widget is the *view*: every repaint derives its content from the model, so
 * toggling a block is just a model change followed by a repaint — the payload can
 * never be lost. Rendering (sanitising, tag escaping, markdown colouring) happens
 * here, in `formatTranscript()`, so the model stays plain text.
 */
export function createTranscriptView({ widget, refresh = () => {} } = {}) {
  const model = new TranscriptModel();
  let closed = false;

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

  /** Append plain text (prose, notices, tool call headers). */
  const log = (...args) => {
    const text = args.map(formatArg).join(' ');
    for (const line of formatLines(text)) model.addLine(line);
    return paint();
  };

  /**
   * Append a collapsible block. `header` is the one-line label the block keeps
   * when collapsed (the "X char response" size is appended by the model) and
   * `body` is the payload, stored verbatim so expanding is lossless.
   */
  const logBlock = ({ header = '', body = '', collapsed = null } = {}) => {
    const source = String(body ?? '');
    const block = model.addBlock({
      header: formatLines(header).join(' '),
      body: source,
      bodyLines: formatLines(source),
      collapsed,
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

  return {
    model,
    log,
    logBlock,
    toggleBlock,
    expandBlock,
    collapseBlock,
    clickAt,
    paint,
    /** True while new output follows the bottom of the transcript. */
    isFollowing: following,
    close() {
      closed = true;
    },
    get content() {
      return model.content;
    },
  };
}
