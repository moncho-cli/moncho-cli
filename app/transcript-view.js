import { TranscriptModel, blockAtClick } from './transcript.js';
import { formatArg, formatTranscript } from './tui-render.js';

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

  /**
   * Repaint the widget from the model.
   *
   * Appending scrolls to the bottom (new output comes into view). Toggling a
   * block passes `keepScroll`, which restores the scroll offset afterwards so
   * expanding a block above the fold does not yank the view to the end.
   */
  const paint = ({ keepScroll = false } = {}) => {
    if (closed || !widget) return false;
    const offset = scrollOffset();
    // The blessed log widget jumps to the bottom on every content change; a
    // toggle must not, so the flag is raised for that repaint only.
    const previous = widget._userScrolled;
    if (keepScroll) widget._userScrolled = true;
    widget.setContent(model.content);
    if (keepScroll) {
      widget.setScroll(offset);
      setImmediate(() => {
        widget._userScrolled = previous;
      });
    }
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
    close() {
      closed = true;
    },
    get content() {
      return model.content;
    },
  };
}
