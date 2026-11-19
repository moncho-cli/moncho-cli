import { createChooser } from './tui-modal.js';
import { reloadConversation } from './session-replay.js';
import { queueSurface } from './queue-bar.js';
import { hintSurface } from './input-hint.js';
import { noticeSurface } from './notice-overlay.js';

/**
 * The public surface of the TUI, kept apart from the screen wiring.
 *
 * `app/tui.js` builds the regions and binds the keys; the object every caller
 * (main.js, the picker, the tests) talks to is assembled here, so adding one more
 * view of a model does not grow the wiring module and the shape stays in one place.
 *
 * The models that own live state (the pending-message queue, the last-prompt hint,
 * the transient notices) are attached with their `…Surface` helpers, which *define*
 * the accessors instead of spreading them: spreading an object literal evaluates its
 * getters once, which would freeze `queuedCount`/`hint`/`notices` at the value they
 * had when the TUI was built.
 *
 * `close` is passed in rather than implemented here: tearing the screen down is the
 * wiring module's business, and the surface must call the very same teardown.
 */
export function createTuiSurface({
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
  modeRow = null,
  inputBox,
  setQueueHeight,
  focusGuard = null,
  noticeBar,
  brandBar = null,
  refresh,
  scrollBy,
  scrollPage,
  log,
  logBlock,
  close,
  isClosed,
  modelLabel = '',
} = {}) {
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
    close,
    // TUI extras
    log,
    logBlock,
    setStatus: (text) => statusRow.setStatus(text),
    setTokens: (text) => statusRow.setMeter(text),
    notifyCompaction: (stats) => {
      if (isClosed()) return;
      compaction.notify(stats);
    },
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
    // The session's intent mode, painted as the leftmost cell of the model row
    // (app/session-mode-label.js): the row itself, plus the state it shows.
    modeRow,
    get modeState() {
      return modeRow ? modeRow.state : null;
    },
    queueBar: queueRegion,
    inputBox,
    setQueueHeight,
    // Keeping the input box armed: the click on the box and the periodic check
    // (app/focus-guard.js). Exposed so the host and the tests can see a repair
    // without reaching into the wiring module.
    focusGuard,
    get focusRepairs() {
      return focusGuard ? focusGuard.repairs : 0;
    },
    // The transient notices near the top of the screen (app/notice-overlay.js).
    noticeBar,
    get isClosed() {
      return isClosed();
    },
    get modelLabel() {
      return modelLabel;
    },
    // The brand line in the top right corner of the conversation (app/brand-bar.js):
    // the bar itself, plus read-only views of the line it paints and of the room the
    // fit rule gave it, because the bar is a view of the line and never the other way
    // round.
    brandBar,
    get brandLine() {
      return brandBar ? brandBar.line : '';
    },
    get brandSize() {
      return brandBar ? brandBar.size : null;
    },
  };

  // The pending-message queue: queued while a request is in flight and drained by
  // the host loop between turns.
  queueSurface(queue, tui);
  // The "Last prompt: ..." hint over an empty input box.
  hintSurface(promptInput.inputHint, tui);
  // The transient notices: notice()/dismissNotice()/notices().
  noticeSurface(noticeBar.overlay, tui);

  return tui;
}
