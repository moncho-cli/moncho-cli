import { createScreen } from './tui-screen.js';
import { describeModel } from '../config/constants.js';
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from './status-row.js';
import { createWiredStatusRows } from './status-rows.js';
import {
  createLayout, TRANSCRIPT_BOTTOM, MODEL_BOTTOM, WORK_BOTTOM, STATUS_BOTTOM, QUEUE_BOTTOM, INPUT_HEIGHT,
} from './tui-layout.js';
import { createTranscriptPane } from './tui-transcript.js';
import { createStamper } from './transcript-stamp.js';
import { createTuiSurface } from './tui-surface.js';
import { createQueueBar } from './queue-bar.js';
import { createPromptInput, normalizePrompt } from './prompt-input.js';
import { createNoticeBar } from './notice-bar.js';
import { createBrandBar } from './brand-bar.js';
import { createFloatingOverlays } from './tui-overlays.js';
import { createPasteRegistry } from './paste-registry.js';
import { createCompactionNotifier } from './compaction-notice.js';
import { createSelectionClipboard } from './tui-clipboard.js';
import { createToastBar } from './tui-toast.js';
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

// Every part of the screen lives in its own module and is re-exported here, so
// app/tui.js stays the single entry point its importers and the specs already use:
// the pure helpers in ./tui-render.js, the transcript in ./transcript.js (bound to a
// widget by ./transcript-view.js and to this screen by ./tui-transcript.js), the layout
// in ./tui-layout.js, the right-aligned rows in ./status-rows.js, the timestamps in
// ./transcript-stamp.js, the queue in ./queue-bar.js, the input box in ./prompt-input.js,
// the notices in ./notice-bar.js, the floating bars in ./tui-overlays.js, the copy toast
// in ./tui-toast.js and the public surface in ./tui-surface.js. What stays *here* is the
// wiring: which region exists, which key reaches it, and in what order it is torn down.
export { sanitize, formatArg, formatTranscript, composeStatusRow, collapsePaste, expandPastes, PASTE_THRESHOLD };
export { formatUserEcho, USER_ECHO_HEADER };
export { SPINNER_FRAMES, SPINNER_INTERVAL_MS };
export { TRANSCRIPT_BOTTOM, MODEL_BOTTOM, WORK_BOTTOM, STATUS_BOTTOM, QUEUE_BOTTOM, INPUT_HEIGHT };
export { createStatusRows } from './status-rows.js';
export { createWorkRow } from './work-row.js';
export { createStamper, formatStamp, withStamp, STAMP_RE, STAMP_WIDTH } from './transcript-stamp.js';
export { createQueueBar, queueSurface } from './queue-bar.js';
export { createMessageQueue, queueRowAt, formatQueueTail, formatQueueRows } from './message-queue.js';
export { formatQueueRow, previewMessage, displayWidth, truncateToWidth, queuePreviewBudget, QUEUE_PREVIEW_CHARS, QUEUE_MAX_ROWS, QUEUE_DELETE_MARKER } from './queue-rows.js';
export { createPromptInput, normalizePrompt } from './prompt-input.js';
export { createInputHint, hintSurface, formatLastPromptHint, LAST_PROMPT_LABEL, HINT_COLOR } from './input-hint.js';
export { createNoticeOverlay, noticeSurface, formatNoticeRows, formatNoticeRow, formatNoticeText, formatRetryNotice, formatFailureNotice, NOTICE_TTL_MS, NOTICE_MAX_ROWS, NOTICE_MAX_KEPT, NOTICE_COLORS, NOTICE_MARKERS, NOTICE_KINDS, NOTICE_MAX_CHARS } from './notice-overlay.js';
export { createNoticeBar } from './notice-bar.js';
export { createBrandBar } from './brand-bar.js';
export { createFloatingOverlays } from './tui-overlays.js';
export { createToastBar } from './tui-toast.js';
export { formatBrand, resolveBrandSize, BRAND_NAME, BRAND_VERSION, BRAND_COLOR, BRAND_TOP, BRAND_RIGHT } from './brand.js';

/**
 * Build the TUI. Returns null when stdout is not a TTY (e.g. `./start.sh start`
 * runs detached, without a pty) so the caller can fall back to the line chat.
 *
 * Its shape is assembled by ./tui-surface.js, so this module stays the wiring:
 * which region exists, which key reaches it, and in what order it is torn down.
 * A non-TTY stdout (`./start.sh start` runs detached) means no screen at all, and
 * null, so the caller can fall back to the line chat.
 */
export function createTui(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  // Escape / Ctrl+C are forwarded to this hook (main.js wires it to the AbortManager).
  const onInterrupt = typeof options.onInterrupt === 'function' ? options.onInterrupt : null;
  // Tab / Shift+Tab are forwarded to this hook with the direction they walk in
  // (main.js wires it to the session mode's cycle()).
  const onCycleMode = typeof options.onCycleMode === 'function' ? options.onCycleMode : null;
  // The timestamp hook of the conversation view (app/transcript-stamp.js): the time
  // each block appeared. Injected so a test can freeze it and `null` marks nothing.
  const stamp = options.stamp === undefined ? createStamper() : options.stamp;

  // No screen means no TTY: the caller falls back to the line chat.
  const terminal = createScreen({ input, output });
  if (!terminal) return null;
  const { screen, refresh, isClosed: screenClosed, markClosed } = terminal;

  // Provider/model identity, resolved once at startup (env-driven).
  const modelLabel = typeof options.modelLabel === 'string' && options.modelLabel
    ? options.modelLabel
    : describeModel().label;

  const {
    transcript, statusBar, workBar, modelBar, queueBar: queueRegion, inputBox, setQueueHeight,
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
  // The clipboard a mouse selection is copied to, and what the reader is told about it
  // (`docs/interface/clipboard-selection`, app/tui-clipboard.js): OSC 52 on the very
  // stream the screen is painted on, and one notice near the top — never a row in the
  // conversation, because a copy is about the reader's clipboard rather than the dialogue.
  const clipboard = createSelectionClipboard({ screen, toast: () => toastBar });
  // The transcript is a model + view pair behind one pane (app/tui-transcript.js):
  // the pane owns the click-to-toggle binding, the mouse selection and the operations the
  // host asks of the conversation, so the wiring below never reaches into the view.
  const pane = createTranscriptPane({
    transcript,
    refresh,
    stamp,
    copy: clipboard.copy,
    notify: clipboard.notify,
    // The screen is what makes a release *outside* the pane finish the gesture: blessed
    // re-emits every mouse report on the screen and only the ones that land on a region
    // there, so the release edge is bound on the screen (app/transcript-mouse.js).
    screen,
  });
  const view = pane.view;

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

  // The three things that float over the top of the screen, built as one group because
  // their order is a single decision: the brand line owns the first row and tells the
  // layout how many rows it took, and the notice overlay and the copy toast both anchor
  // *below* it so neither can cover the mark (app/tui-overlays.js).
  const overlays = createFloatingOverlays({
    screen,
    refresh,
    reserve: (rows) => setBrandRows(rows),
    // The room is the screen itself: the mark is its first line, so the transcript's
    // geometry is irrelevant to whether the line fits.
    brandWidth: () => Number(screen.width) || 0,
    brandHeight: () => Number(screen.height) || 0,
  });
  const { brandBar, noticeBar, toastBar } = overlays;

  // The input box has two states: an armed question between turns, and a
  // capturing box while a request is in flight — where Enter queues the message
  // instead of resolving a question nobody armed (app/prompt-input.js).
  const promptInput = createPromptInput({
    inputBox,
    pastes,
    queue,
    log: (...args) => pane.log(...args),
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

  // The two right-aligned rows above the model row, wired to their widgets here and
  // built as one pair (app/status-rows.js) so they can never drift a cell apart: the
  // working-time counter on top and the status bar with the context-window meter under
  // it, both visible while the spinner owns the left slot. The wiring — the two boxes,
  // the screen's own width and the closed-screen gate — lives in that module, which
  // exists to keep this file the *wiring* and nothing more.
  const statusRows = createWiredStatusRows({
    screen,
    statusBar,
    workBar,
    refresh,
    columns: output.columns,
    isClosed: screenClosed,
  });
  const statusRow = statusRows.statusRow;

  const log = (...args) => pane.log(...args);

  /**
   * Log a tool result as a collapsible block: the transcript shows one header line
   * with the "X char response" size, and a click expands or collapses the payload.
   */
  const logBlock = (options_) => pane.logBlock(options_);

  // Compaction fires while a request is in flight, i.e. exactly when the status
  // bar's left slot is owned by the spinner, so the marker goes to the transcript
  // to be visible right away — once per event (app/compaction-notice.js).
  const compaction = createCompactionNotifier({ log });

  inputBox.on('submit', (value) => {
    promptInput.submit(value);
  });

  const question = (prompt, callback) => promptInput.question(prompt, callback);

  // A click on the queue bar deletes the message on that row and nothing else; the
  // transcript's own click is bound by the pane.
  queueRegion.on('click', (data) => {
    queue.clickAt(data);
  });

  // Escape / Ctrl+C and the scrolling keys (app/tui-keys.js): the interrupt is
  // taken on the program so blessed cannot turn Escape into the textarea's own
  // 'cancel', and the scrolling keys are taken on the screen so a synthetic
  // `screen.emit('keypress', …)` reaches them.
  const keys = bindKeys({
    screen,
    onInterrupt,
    onCycleMode,
    scrollPage: (direction) => pane.scrollPage(direction),
    transcript,
    refresh,
  });

  // A resize re-fits every row measured at the old width and puts the newest line
  // back in view (app/tui-teardown.js).
  createResizeRepaint({
    screen, transcript, statusRow, workRow: statusRows.workRow, queue, overlays,
  });

  // The teardown is the reverse of construction, and happens once: the input box
  // stops accepting keystrokes first, then the regions that own a timer or a widget
  // are closed, and the screen goes last (app/tui-teardown.js).
  const close = createTeardown({
    steps: [
      () => promptInput.abandon(),
      () => queue.close(),
      () => modeRow.close(),
      () => overlays.close(),
      () => view.close(),
      () => keys.dispose(),
      () => focusGuard.close(),
      () => statusRows.dispose(),
    ],
    screen,
    state: { isClosed: screenClosed, markClosed },
  });

  statusRows.render();
  queue.paint();
  overlays.paint();

  return createTuiSurface({
    question,
    promptInput,
    view,
    selection: pane.selection,
    queue,
    queueRegion,
    pastes,
    compaction,
    statusRow,
    workRow: statusRows.workRow,
    screen,
    transcript,
    statusBar,
    workBar,
    modelBar,
    modeRow,
    inputBox,
    setQueueHeight,
    focusGuard,
    noticeBar,
    toastBar,
    brandBar,
    refresh,
    scrollBy: (amount) => pane.scrollBy(amount),
    scrollPage: (direction) => pane.scrollPage(direction),
    log,
    logBlock,
    close,
    isClosed: screenClosed,
    modelLabel,
  });
}
