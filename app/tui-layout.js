import blessed from 'neo-blessed';
import { sanitize } from './tui-render.js';

// Screen regions (from the bottom up):
//   input box : bottom 0, height 3 (border 'line')
//   queue     : bottom 3, height 0..n -> pending messages, one ✕ row each
//   status bar: bottom 3 + queue height, height 1
//   model row : bottom 4 + queue height, height 1 -> provider/model label
//   transcript: bottom 5 + queue height .. below the brand row -> the conversation
//   brand line: row 0, right-aligned -> "MONCHO (v x.y.z)"
//
// Two regions can move the others:
//  - the queue bar, while it is empty it is hidden and every region above it keeps
//    its base anchor (see setQueueHeight);
//  - the brand row, the very first line of the screen: while the mark is shown the
//    conversation is displaced one row down, and it gets the row back when the mark
//    is hidden because the window is too narrow to hold it (see setBrandRows).
export const TRANSCRIPT_BOTTOM = 5;
export const MODEL_BOTTOM = 4;
export const STATUS_BOTTOM = 3;
export const QUEUE_BOTTOM = STATUS_BOTTOM;
export const INPUT_HEIGHT = 3;

/** Rows the conversation is displaced by, at the top, for the brand line. */
export const BRAND_BAND_ROWS = 0;

/**
 * Build the blessed regions of the TUI.
 *
 * Kept apart from app/tui.js so the orchestration (keys, questions, the public
 * surface) stays readable and the layout numbers live in one place. The regions
 * are positioned relatively, so blessed relayouts them on resize.
 */
export function createLayout({ screen, modelLabel = '' } = {}) {
  const transcript = blessed.log({
    parent: screen,
    label: ' Conversation ',
    // Row 0 belongs to the brand line (setBrandRows): the conversation starts one row
    // below it while the mark is shown, and comes back to the top edge when it is not.
    top: BRAND_BAND_ROWS,
    left: 0,
    right: 0,
    bottom: TRANSCRIPT_BOTTOM,
    border: { type: 'line' },
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    // A click toggles the tool result block under the cursor (see
    // app/transcript-view.js) but must never move the caret. blessed autofocuses
    // every clickable region whose `autoFocus` is left on (its `element click`
    // handler in lib/widgets/screen.js), and focusing the transcript blurs the
    // input box and ends its read cycle -- the "input box loses focus" bug that
    // app/focus-guard.js repairs.
    clickable: true,
    autoFocus: false,
    scrollbar: { ch: ' ', style: { inverse: true } },
    padding: { left: 1, right: 1 },
  });

  const statusBar = blessed.box({
    parent: screen,
    left: 0,
    right: 0,
    bottom: STATUS_BOTTOM,
    height: 1,
    tags: false,
    padding: { left: 1, right: 1 },
    content: 'Ready',
  });

  const modelBar = blessed.box({
    parent: screen,
    left: 0,
    right: 0,
    bottom: MODEL_BOTTOM,
    height: 1,
    tags: false,
    padding: { left: 1, right: 1 },
    content: sanitize(modelLabel),
  });

  // The queue bar sits right above the input box and is hidden while the queue
  // is empty, so it costs no row when nothing is waiting. Its rows are painted
  // by app/queue-bar.js and a click on a row deletes that message.
  const queueBar = blessed.box({
    parent: screen,
    left: 0,
    right: 0,
    bottom: QUEUE_BOTTOM,
    height: 0,
    tags: true,
    hidden: true,
    // A click deletes the message on that row (app/queue-bar.js) and, like the
    // transcript, must not take the focus away from the input box.
    clickable: true,
    autoFocus: false,
    padding: { left: 1, right: 1 },
  });

  // `inputOnFocus` is deliberately NOT set: it makes neo-blessed arm a read on
  // every 'focus' event, while app/tui.js arms one explicitly in question().
  // The two paths overlap around the picker modal (blessed destroys the modal,
  // the box gets a blur, a focus and another read) and, because textarea
  // attaches its key listener from a deferred tick, the overlapping read cycles
  // leave TWO 'keypress' listeners on the box -- every later keystroke is then
  // appended twice. question() is the single arming point, so focusing the box
  // (e.g. when the modal closes) never starts a read of its own.
  const inputBox = blessed.textbox({
    parent: screen,
    label: ' > ',
    bottom: 0,
    left: 0,
    right: 0,
    height: INPUT_HEIGHT,
    border: { type: 'line' },
    tags: false,
    // Clickable, so the box can be clicked back into focus -- but with `autoFocus`
    // off: blessed's own autofocus focuses through `screen.focused = el`, which
    // emits a `blur` on the box and ends the very read it is holding. The click is
    // handled explicitly instead (app/focus-guard.js#bindFocusGuard), where the box
    // is only focused when it does not already own the focus.
    clickable: true,
    autoFocus: false,
    padding: { left: 1, right: 1 },
  });

  /**
   * Make room for `rows` queue rows right above the input box: the status bar,
   * the model row and the transcript shift up by that many rows, and at 0 the
   * region is hidden again and every anchor is restored to its base value.
   *
   * Returns the height actually applied, so the caller can tell whether the
   * layout moved.
   */
  function setQueueHeight(rows = 0) {
    const height = Math.max(0, Math.trunc(Number(rows)) || 0);
    const offset = height;

    queueBar.height = height;
    queueBar.hidden = height === 0;
    statusBar.bottom = STATUS_BOTTOM + offset;
    modelBar.bottom = MODEL_BOTTOM + offset;
    transcript.bottom = TRANSCRIPT_BOTTOM + offset;
    return height;
  }

  /**
   * Displace the conversation by `rows` rows to make room for the brand line on row
   * 0, which is what "the right aligned MONCHO and version would be the very first
   * top line (displacing the conversation edge 1 line below)" means; 0 puts the
   * conversation back on the top edge.
   *
   * Moving the region's `top` rather than padding it is what makes the row *belong*
   * to the mark: the conversation's own border becomes the row below it.
   *
   * Returns the offset actually applied, so the caller can tell whether it moved.
   */
  function setBrandRows(rows = 0) {
    const offset = Math.max(0, Math.trunc(Number(rows)) || 0);
    transcript.top = offset;
    return offset;
  }

  return {
    transcript, statusBar, modelBar, queueBar, inputBox, setQueueHeight, setBrandRows,
  };
}
