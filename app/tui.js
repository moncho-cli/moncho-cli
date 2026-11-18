import blessed from 'neo-blessed';
import { describeModel } from '../config/constants.js';
import { createStatusRow, SPINNER_FRAMES, SPINNER_INTERVAL_MS } from './status-row.js';
import {
  createLayout, TRANSCRIPT_BOTTOM, MODEL_BOTTOM, STATUS_BOTTOM, QUEUE_BOTTOM, INPUT_HEIGHT,
} from './tui-layout.js';
import { createTranscriptView } from './transcript-view.js';
import { createTuiSurface } from './tui-surface.js';
import { createQueueBar } from './queue-bar.js';
import { createPromptInput, normalizePrompt } from './prompt-input.js';
import { createNoticeBar } from './notice-bar.js';
import { createPasteRegistry } from './paste-registry.js';
import { createCompactionNotifier } from './compaction-notice.js';
import { bindKeys } from './tui-keys.js';
import {
  sanitize,
  formatArg,
  formatTranscript,
  composeStatusRow,
  formatUserEcho,
  USER_ECHO_HEADER,
  collapsePaste,
  expandPastes,
  PASTE_THRESHOLD,
} from './tui-render.js';

// The pure helpers live in ./tui-render.js, the transcript model in
// ./transcript.js (bound to the widget by ./transcript-view.js), the region
// layout in ./tui-layout.js, the status-row bookkeeping in ./status-row.js, the
// paste table in ./paste-registry.js, the compaction notice in
// ./compaction-notice.js, the pending-message queue in ./message-queue.js (bound
// to its region by ./queue-bar.js), the input-box state machine in
// ./prompt-input.js, the transient notices in ./notice-overlay.js (bound to their
// overlay by ./notice-bar.js) and the public surface in ./tui-surface.js. They are
// all re-exported here so app/tui.js stays the single entry point every importer
// (and the specs) already use.
export { sanitize, formatArg, formatTranscript, composeStatusRow, collapsePaste, expandPastes, PASTE_THRESHOLD };
export { formatUserEcho, USER_ECHO_HEADER };
export { SPINNER_FRAMES, SPINNER_INTERVAL_MS };
export { TRANSCRIPT_BOTTOM, MODEL_BOTTOM, STATUS_BOTTOM, QUEUE_BOTTOM, INPUT_HEIGHT };
export { createQueueBar, queueSurface } from './queue-bar.js';
export { createMessageQueue, formatQueueRows, formatQueueRow, previewMessage, queueRowAt, QUEUE_MAX_ROWS, QUEUE_DELETE_MARKER } from './message-queue.js';
export { createPromptInput, normalizePrompt } from './prompt-input.js';
export { createInputHint, hintSurface, formatLastPromptHint, LAST_PROMPT_LABEL, HINT_COLOR } from './input-hint.js';
export { createNoticeOverlay, noticeSurface, formatNoticeRows, formatNoticeRow, formatNoticeText, formatRetryNotice, formatFailureNotice, NOTICE_TTL_MS, NOTICE_MAX_ROWS, NOTICE_MAX_KEPT, NOTICE_COLORS, NOTICE_MARKERS, NOTICE_KINDS, NOTICE_MAX_CHARS } from './notice-overlay.js';
export { createNoticeBar } from './notice-bar.js';

/**
 * Build the TUI. Returns null when stdout is not a TTY (e.g. `./start.sh start`
 * runs detached, without a pty) so the caller can fall back to the line chat.
 *
 * The returned object mirrors createCLI() ({ rl, question, exit, close }) and
 * adds log()/logBlock()/setStatus() for rendering the conversation and the status
 * bar. Its shape is assembled by ./tui-surface.js, so this module stays the screen
 * wiring: the regions, the keys and the teardown.
 */
export function createTui(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  // Escape / Ctrl+C are forwarded to this hook (main.js wires it to the AbortManager).
  const onInterrupt = typeof options.onInterrupt === 'function' ? options.onInterrupt : null;

  if (!output.isTTY) return null;

  const screen = blessed.screen({
    input,
    output,
    smartCSR: true,
    fullUnicode: true,
    title: 'Moncho',
    warnings: false,
    autoPadding: true,
  });

  // Provider/model identity, resolved once at startup (env-driven).
  const modelLabel = typeof options.modelLabel === 'string' && options.modelLabel
    ? options.modelLabel
    : describeModel().label;

  const {
    transcript, statusBar, modelBar, queueBar: queueRegion, inputBox, setQueueHeight,
  } = createLayout({ screen, modelLabel });

  const pastes = createPasteRegistry();
  let closed = false;

  const refresh = () => {
    if (!closed) screen.render();
  };

  // The transcript is a model + view pair: the model holds the entries (plain
  // lines and collapsible blocks), the view paints them and resolves clicks.
  const view = createTranscriptView({ widget: transcript, refresh });

  // The queue bar is the pending-message region right above the input box: the
  // model owns the order and the text, the bar paints the rows and resizes the
  // region so everything above it shifts up by the queue height.
  const queue = createQueueBar({
    widget: queueRegion,
    setHeight: setQueueHeight,
    refresh,
  });

  // The transient notices float over the top of the transcript instead of taking a
  // row from it, so the regions below never move; the box hides itself while there
  // is nothing live and on a timer armed for the earliest expiry
  // (app/notice-bar.js, app/notice-overlay.js).
  const noticeBar = createNoticeBar({ screen, refresh });

  // The input box has two states: an armed question between turns, and a
  // capturing box while a request is in flight — where Enter queues the message
  // instead of resolving a question nobody armed (app/prompt-input.js).
  const promptInput = createPromptInput({
    inputBox,
    pastes,
    queue,
    log: (...args) => view.log(...args),
    refresh,
  });

  // The status bar carries two independent pieces of information on one row: the
  // logical status (or the spinner frame) on the left, and the context-window
  // meter pinned to the right, so usage stays visible while a request is in
  // flight. The box pads one column on each side, so width() reports the usable
  // interior.
  const statusRow = createStatusRow({
    width: () => {
      const width = Number(screen.width) || Number(output.columns) || 0;
      return width > 2 ? width - 2 : 0;
    },
    paint: (line) => {
      if (closed) return;
      statusBar.setContent(line);
      refresh();
    },
  });

  const log = (...args) => view.log(...args);

  /**
   * Log a tool result as a collapsible block: the transcript shows one header line
   * with the "X char response" size, and a click expands or collapses the payload.
   */
  const logBlock = (options_) => view.logBlock(options_);

  // Compaction fires while a request is in flight, i.e. exactly when the status
  // bar's left slot is owned by the spinner, so the marker goes to the transcript
  // to be visible right away — once per event (app/compaction-notice.js).
  const compaction = createCompactionNotifier({ log });

  inputBox.on('submit', (value) => {
    promptInput.submit(value);
  });

  const question = (prompt, callback) => promptInput.question(prompt, callback);

  // Scrolling must work even while the input box owns the focus. Both steps go
  // through the view, so the wheel and the keyboard move the same distances and
  // a scroll only moves the viewport instead of rebuilding the whole content.
  const scrollBy = (amount) => {
    view.scrollRows(amount);
  };

  /** Page towards the bottom (`direction < 0` pages up), one screenful minus one. */
  const scrollPage = (direction) => {
    view.scrollPage(direction);
  };

  // A click on the transcript toggles the tool-result block under the cursor
  // (expand, then collapse again on the next click); a click on the queue bar
  // deletes the message on that row and nothing else.
  transcript.on('click', (data) => {
    view.clickAt(data);
  });
  queueRegion.on('click', (data) => {
    queue.clickAt(data);
  });

  // Escape / Ctrl+C and the scrolling keys (app/tui-keys.js): the interrupt is
  // taken on the program so blessed cannot turn Escape into the textarea's own
  // 'cancel', and the scrolling keys are taken on the screen so a synthetic
  // `screen.emit('keypress', …)` reaches them.
  const keys = bindKeys({ screen, onInterrupt, scrollPage, transcript, refresh });

  // Regions are laid out relatively, so blessed relayouts them on resize; we only
  // have to repaint the status row (whose width changed) and keep the newest line
  // in view.
  screen.on('resize', () => {
    transcript.setScrollPerc(100);
    statusRow.render();
  });

  const close = () => {
    if (closed) return;
    closed = true;
    promptInput.abandon();
    queue.close();
    noticeBar.close();
    view.close();
    keys.dispose();
    statusRow.dispose();
    screen.destroy();
  };

  statusRow.render();
  queue.paint();

  return createTuiSurface({
    question,
    promptInput,
    view,
    queue,
    queueRegion,
    pastes,
    compaction,
    statusRow,
    screen,
    transcript,
    statusBar,
    modelBar,
    inputBox,
    setQueueHeight,
    noticeBar,
    refresh,
    scrollBy,
    scrollPage,
    log,
    logBlock,
    close,
    isClosed: () => closed,
    modelLabel,
  });
}
