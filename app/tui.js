import blessed from 'neo-blessed';
import { describeModel } from '../config/constants.js';
import { createStatusRow, SPINNER_FRAMES, SPINNER_INTERVAL_MS } from './status-row.js';
import {
  createLayout, TRANSCRIPT_BOTTOM, MODEL_BOTTOM, STATUS_BOTTOM, QUEUE_BOTTOM, INPUT_HEIGHT,
} from './tui-layout.js';
import { createTranscriptView } from './transcript-view.js';
import { createChooser } from './tui-modal.js';
import { createQueueBar, queueSurface } from './queue-bar.js';
import { createPromptInput, normalizePrompt } from './prompt-input.js';
import { createPasteRegistry } from './paste-registry.js';
import { createCompactionNotifier } from './compaction-notice.js';
import { bindKeys } from './tui-keys.js';
import { reloadConversation } from './session-replay.js';
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
// to its region by ./queue-bar.js) and the input-box state machine in
// ./prompt-input.js. They are all re-exported here so app/tui.js stays the single
// entry point every importer (and the specs) already use.
export { sanitize, formatArg, formatTranscript, composeStatusRow, collapsePaste, expandPastes, PASTE_THRESHOLD };
export { formatUserEcho, USER_ECHO_HEADER };
export { SPINNER_FRAMES, SPINNER_INTERVAL_MS };
export { TRANSCRIPT_BOTTOM, MODEL_BOTTOM, STATUS_BOTTOM, QUEUE_BOTTOM, INPUT_HEIGHT };
export { createQueueBar, queueSurface } from './queue-bar.js';
export { createMessageQueue, formatQueueRows, formatQueueRow, previewMessage, queueRowAt, QUEUE_MAX_ROWS, QUEUE_DELETE_MARKER } from './message-queue.js';
export { createPromptInput, normalizePrompt } from './prompt-input.js';

/**
 * Build the TUI. Returns null when stdout is not a TTY (e.g. `./start.sh start`
 * runs detached, without a pty) so the caller can fall back to the line chat.
 *
 * The returned object mirrors createCLI() ({ rl, question, exit, close }) and
 * adds log()/logBlock()/setStatus() for rendering the conversation and the status
 * bar.
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

  // The input box has two states: an armed question between turns, and a
  // capturing box while a request is in flight — where Enter queues the message
  // instead of resolving a question nobody armed (app/prompt-input.js).
  const promptInput = createPromptInput({
    inputBox,
    pastes,
    queue: queue.queue,
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

  const setStatus = (text) => statusRow.setStatus(text);

  // The status bar doubles as the context-window meter: usage() renders as
  // "<used> / <max> tokens (<pct>%)", right-aligned and always visible.
  const setTokens = (text) => statusRow.setMeter(text);

  // Compaction fires while a request is in flight, i.e. exactly when the status
  // bar's left slot is owned by the spinner, so the marker goes to the transcript
  // to be visible right away — once per event (app/compaction-notice.js).
  const compaction = createCompactionNotifier({ log });
  const notifyCompaction = (stats) => {
    if (closed) return;
    compaction.notify(stats);
  };

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

  statusRow.render();
  queue.paint();

  const tui = {
    // createCLI()-compatible surface
    rl: {
      question: (prompt, callback) => question(prompt, callback),
    },
    question,
    // Settle an armed question with the 'exit' sentinel the host loop understands.
    exit() {
      return promptInput.exit();
    },
    /** Reload a whole conversation (a resumed session) into the transcript. */
    reload: (chunks) => {
      // The transcript is replaced, so a compaction already announced is no
      // longer on screen: the next one must be reported again.
      compaction.reset();
      return reloadConversation(chunks, { log, logBlock, clear: () => view.clear() });
    },
    close() {
      if (closed) return;
      closed = true;
      promptInput.abandon();
      queue.close();
      view.close();
      keys.dispose();
      statusRow.dispose();
      screen.destroy();
    },
    // TUI extras
    log,
    logBlock,
    setStatus,
    setTokens,
    notifyCompaction,
    /**
     * Start the in-flight state: the spinner runs **and** the input box stays
     * armed, so a message typed now is queued instead of going nowhere.
     */
    startSpinner(label) {
      promptInput.startFlight();
      return statusRow.startSpinner(label);
    },
    stopSpinner() {
      promptInput.endFlight();
      return statusRow.stopSpinner();
    },
    isSpinning: () => statusRow.isSpinning(),
    // Transcript blocks: read, toggle, expand, collapse (used by main.js and tests)
    get transcriptModel() {
      return view.model;
    },
    get blocks() {
      return view.model.blocks;
    },
    toggleBlock: (id) => view.toggleBlock(id),
    expandBlock: (id) => view.expandBlock(id),
    collapseBlock: (id) => view.collapseBlock(id),
    clickTranscript: (data) => view.clickAt(data),
    /**
     * Ask the user to pick one of `labels`, in a modal.
     *
     * Resolves with the index of the choice, or null when cancelled — the shape
     * the command registry's `choose(labels, { title })` expects.
     */
    choose: createChooser({ screen, inputBox, render: refresh }),
    collapsePaste: (text) => pastes.collapse(text).text,
    expandPastes: (text) => pastes.expand(text),
    get pastes() {
      return pastes.all;
    },
    refresh,
    scrollBy,
    scrollPage,
    get transcriptView() {
      return view;
    },
    screen,
    transcript,
    statusBar,
    modelBar,
    queueBar: queueRegion,
    inputBox,
    setQueueHeight,
    get isClosed() {
      return closed;
    },
    get modelLabel() {
      return modelLabel;
    },
  };

  // The pending-message queue (task.md): queued while a request is in flight and
  // drained by the host loop between turns. Defined rather than spread, so the
  // `queuedCount`/`queued` accessors stay live.
  queueSurface(queue, tui);
  return tui;
}
