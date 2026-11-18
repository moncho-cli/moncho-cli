import blessed from 'neo-blessed';
import { sanitize } from './tui-render.js';

// Screen regions (from the bottom up):
//   input box : bottom 0, height 3 (border 'line')
//   status bar: bottom 3, height 1
//   model row : bottom 4, height 1 -> provider/model label
//   transcript: bottom 5 .. top 0 -> scrollable, bordered conversation log
export const TRANSCRIPT_BOTTOM = 5;
export const MODEL_BOTTOM = 4;
export const STATUS_BOTTOM = 3;
export const INPUT_HEIGHT = 3;

/**
 * Build the five blessed regions of the TUI.
 *
 * Kept apart from app/tui.js so the orchestration (keys, questions, the public
 * surface) stays readable and the layout numbers live in one place. The regions
 * are positioned relatively, so blessed relayouts them on resize.
 */
export function createLayout({ screen, modelLabel = '' } = {}) {
  const transcript = blessed.log({
    parent: screen,
    label: ' Conversation ',
    top: 0,
    left: 0,
    right: 0,
    bottom: TRANSCRIPT_BOTTOM,
    border: { type: 'line' },
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    // The transcript is the only clickable region: a click toggles the tool
    // result block under the cursor (see app/transcript-view.js).
    clickable: true,
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
    padding: { left: 1, right: 1 },
  });

  return { transcript, statusBar, modelBar, inputBox };
}
