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
import { createBrandBar } from './brand-bar.js';
import { createPasteRegistry } from './paste-registry.js';
import { createCompactionNotifier } from './compaction-notice.js';
import { bindKeys } from './tui-keys.js';
import { bindFocusGuard } from './focus-guard.js';
import { createResizeRepaint, createTeardown } from './tui-teardown.js';
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
export { createMessageQueue, queueRowAt, formatQueueTail, formatQueueRows } from './message-queue.js';
export { formatQueueRow, previewMessage, displayWidth, truncateToWidth, queuePreviewBudget, QUEUE_PREVIEW_CHARS, QUEUE_MAX_ROWS, QUEUE_DELETE_MARKER } from './queue-rows.js';
export { createPromptInput, normalizePrompt } from './prompt-input.js';
export { createInputHint, hintSurface, formatLastPromptHint, LAST_PROMPT_LABEL, HINT_COLOR } from './input-hint.js';
export { createNoticeOverlay, noticeSurface, formatNoticeRows, formatNoticeRow, formatNoticeText, formatRetryNotice, formatFailureNotice, NOTICE_TTL_MS, NOTICE_MAX_ROWS, NOTICE_MAX_KEPT, NOTICE_COLORS, NOTICE_MARKERS, NOTICE_KINDS, NOTICE_MAX_CHARS } from './notice-overlay.js';
export { createNoticeBar } from './notice-bar.js';
export { createBrandBar } from './brand-bar.js';
export { formatBrand, resolveBrandSize, BRAND_NAME, BRAND_VERSION, BRAND_COLOR, BRAND_TOP, BRAND_RIGHT } from './brand.js';

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
  // Tab / Shift+Tab are forwarded to this hook with the direction they walk in
  // (main.js wires it to the session mode's cycle()).
  const onCycleMode = typeof options.onCycleMode === 'function' ? options.onCycleMode : null;

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

  // The screen is repainted by whichever part of the wiring changes something on
  // it, so the mode row built below can repaint itself when the mode moves.
  let closed = false;

  const refresh = () => {
    if (!closed) screen.render();
  };

  const {
    transcript, statusBar, modelBar, queueBar: queueRegion, inputBox, setQueueHeight,
    setBrandRows, modeRow,
  } = createLayout({
    screen,
    modelLabel,
    // The session's intent mode (app/session-mode.js), or a plain state object:
    // the layout paints it as the leftmost cell of the model row and repaints on
    // every accepted change, never on a refused one.
    mode: options.mode || null,
    repaint: refresh,
  });

  const pastes = createPasteRegistry();
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
    // The rows are fitted to the width the bar really has (app/queue-rows.js): a long
    // queued message uses the whole of a wide terminal instead of a fixed
    // 48-character preview, and never wraps past the region's height.
    columns: () => {
      const width = Number(screen.width) || Number(output.columns) || 0;
      return width > 2 ? width - 2 : 0;
    },
  });

  // The brand line sits on the very first row of the screen, right-aligned:
  // "MONCHO (v x.y.z)", the one mark a character-cell front end can render
  // faithfully (see app/brand.js). It is built *before* the notice overlay so the
  // notice anchors below it and never covers the mark.
  const brandBar = createBrandBar({
    screen,
    refresh,
    // The bar tells the layout how many rows it occupies, so the conversation is
    // displaced down by that many while the mark is shown and returns when it hides.
    reserve: (rows) => setBrandRows(rows),
    region: () => ({
      // The room is the screen itself: the mark is its first line, so the
      // transcript's geometry is irrelevant to whether the line fits.
      width: Number(screen.width) || 0,
      height: Number(screen.height) || 0,
    }),
  });

  // The transient notices float over the top of the transcript instead of taking a
  // row from it, so the regions below never move; the box hides itself while there
  // is nothing live and on a timer armed for the earliest expiry
  // (app/notice-bar.js, app/notice-overlay.js).
  const noticeBar = createNoticeBar({ screen, refresh, anchor: () => brandBar.band });

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

  // The input box keeps its focus and its read cycle on a click and on a timer: a
  // click on another region can no longer take the caret away (both regions opt out
  // of blessed's autofocus, app/tui-layout.js) and any other cause of a lost focus
  // is repaired by the periodic check. The guard only acts while the box is
  // *supposed* to be armed -- an armed question or an in-flight turn -- and never
  // while a modal owns the keyboard (app/focus-guard.js).
  const focusGuard = bindFocusGuard({
    inputBox,
    promptInput,
    hold: () => promptInput.isArmed || promptInput.inFlight,
  });
  focusGuard.start();

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
  const keys = bindKeys({ screen, onInterrupt, onCycleMode, scrollPage, transcript, refresh });

  // A resize re-fits every row measured at the old width and puts the newest line
  // back in view (app/tui-teardown.js).
  createResizeRepaint({ screen, transcript, statusRow, queue, brandBar, noticeBar });

  // The teardown is the reverse of construction, and happens once: the input box
  // stops accepting keystrokes first, then the regions that own a timer or a widget
  // are closed, and the screen goes last (app/tui-teardown.js).
  const close = createTeardown({
    steps: [
      () => promptInput.abandon(),
      () => queue.close(),
      () => modeRow.close(),
      () => noticeBar.close(),
      () => brandBar.close(),
      () => view.close(),
      () => keys.dispose(),
      () => focusGuard.close(),
      () => statusRow.dispose(),
    ],
    screen,
    state: { isClosed: () => closed, markClosed: () => { closed = true; } },
  });

  statusRow.render();
  queue.paint();
  brandBar.paint();

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
    modeRow,
    inputBox,
    setQueueHeight,
    focusGuard,
    noticeBar,
    brandBar,
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
