import { createChooser } from './tui-modal.js';
import { openContentModal } from './content-modal.js';
import { activePalette, activeTokens } from './theme.js';
import { logEvent } from '../utils/logger.js';
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
  setBusySubmit = null,
  view,
  selection = null,
  queue,
  queueRegion,
  pastes,
  compaction,
  statusRow,
  workRow = null,
  screen,
  transcript,
  statusBar,
  workBar = null,
  modelBar,
  modeRow = null,
  inputBox,
  setQueueHeight,
  focusGuard = null,
  noticeBar,
  toastBar = null,
  brandBar = null,
  slashBar = null,
  sticky = null,
  clipboard = null,
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
    // Install the host's mid-turn command handler once the host exists
    // (app/busy-command.js); absent in a front end without one.
    setBusySubmit: typeof setBusySubmit === 'function' ? setBusySubmit : () => null,
    // Settle an armed question with the 'exit' sentinel the host loop understands.
    exit() {
      return promptInput.exit();
    },
    /**
     * Reload a whole conversation (a resumed session) into the transcript.
     *
     * Timestamps are switched off for the duration: those rows appeared in a past
     * run, so marking them with the time the file was reopened would state
     * something false (`docs/interface/conversation-timestamps`).
     */
    reload: (chunks, { stamps = [] } = {}) => {
      // The transcript is replaced, so a compaction already announced is no
      // longer on screen: the next one must be reported again.
      compaction.reset();
      if (typeof view.setStamping === 'function') view.setStamping(false);
      try {
        return reloadConversation(chunks, {
          log,
          // The same prose route the live loop uses, so a resumed conversation shows
          // its two sides banded exactly as they were (docs/interface/prose-bands).
          logProse: tui.logProse,
          logBlock,
          clear: () => view.clear(),
          // The repaint is suspended for the whole replay and taken once at the end:
          // painting per entry re-renders a transcript that is still growing, so a
          // large session cost seconds instead of milliseconds
          // (docs/interface/session-replay).
          bulk: (fn) => view.bulk(fn),
          // The append times the record kept, so the rows are marked with when they
          // were written rather than with the time the file was reopened
          // (docs/interface/session-stamps).
          stamps,
        });
      } finally {
        if (typeof view.setStamping === 'function') view.setStamping(true);
      }
    },
    close,
    // TUI extras
    log,
    /**
     * Print one side of the dialogue as a background-banded entry: the user's echoed
     * prompt or the model's prose (`docs/interface/prose-bands`). The host wires it to
     * the seams that log those two, so the banding rule stays in the transcript pane
     * (app/transcript-view.js).
     */
    logProse: (role, text, { stamp = null } = {}) => view.logProse(role, text, { stamp }),
    logBlock,
    setStatus: (text) => statusRow.setStatus(text),
    setTokens: (text) => statusRow.setMeter(text),
    /**
     * Paint the working-time counter on the row above the meter.
     *
     * The value is a `{ thinkingMs, toolMs, totalMs }` snapshot
     * (`utils/working-time.js`); the row is empty until the session has worked, so
     * a fresh conversation shows no `working 0s`.
     */
    setWork: (totals) => (workRow ? workRow.setTotals(totals) : null),
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
     * The mouse selection in the conversation (`docs/interface/clipboard-selection`): the
     * gesture itself, so the host and the tests can see a drag without a terminal.
     */
    selection,
    get selectionRange() {
      return selection ? selection.selection : null;
    },
    /**
     * Ask the user to pick one of `labels`, in a modal.
     *
     * Resolves with the index of the choice, or null when cancelled — the shape
     * the command registry's `choose(labels, { title })` expects.
     */
    choose: createChooser({ screen, inputBox, render: refresh }),
    /**
     * Show documents read-only, in a modal (`app/content-modal.js`).
     *
     * `/task` is the one command that needs it: the tracking pair is shown exactly as
     * it is on disk, with nothing to press but the keys that close it. Resolves with
     * `{ closed, document }`, or null when there was nothing to show.
     */
    /**
     * Ask a yes/no question in the picker modal.
     *
     * Resolves `true` only for the first choice: a cancelled modal is a no. The same
     * contract as the line CLI's `confirm()`, so a command asks the same question on
     * either front end and gets the same answer shape.
     */
    confirm: async (question, { title = 'Confirm' } = {}) => {
      const choice = await tui.choose([`Yes — ${question}`, 'No'], { title });
      return choice === 0;
    },
    contentView: ({ documents = [], title = 'Content', reload = null } = {}) => openContentModal({
      screen,
      documents,
      title,
      refresh,
      // A live re-read, when the command supplied one: the viewer follows the tracking files
      // while it is open instead of freezing the bytes it was opened with.
      reload,
      // The viewer is selectable and copyable like the conversation
      // (`docs/interface/clipboard-selection`): the same writer, the same toast.
      copy: clipboard ? (text) => clipboard.copy(text) : null,
      notify: clipboard ? (report) => clipboard.notify(report) : null,
      // The focus comes back to the box when the modal closes, like every other modal:
      // the box is the single arming point, so the host's next read finds it focused.
      onOpenChange: (open) => {
        if (!open && inputBox) inputBox.focus();
      },
    }),
    collapsePaste: (text) => pastes.collapse(text).text,
    expandPastes: (text) => pastes.expand(text),
    get pastes() {
      return pastes.all;
    },
    refresh,
    /**
     * Repaint every region that paints a colour read live from the theme
     * (`docs/interface/skins`): after `/skins` moved the palette, the border, the brand
     * mark, the notice rows, the copy toast and the slash popup all re-read it here, and
     * the transcript is repainted in place so the chrome and the next rows wear the new
     * skin. The rows already on screen keep the colours they were painted with — the
     * transcript stores rendered lines, not raw ones — which is what the spec states.
     */
    repaintTheme: () => {
      brandBar?.paint?.();
      noticeBar?.paint?.();
      toastBar?.paint?.();
      slashBar?.paint?.();
      // The pinned row paints the palette's stamp colour, so a skin reaches it here.
      sticky?.paint?.();
      // The transcript is repainted **from the model**, not from a frozen frame: every
      // stored row is re-coloured at paint time (`app/transcript-view.js#paintRecord`), so
      // a skin reaches the rows already on screen and not only the chrome. This is the one
      // call that proves it, so its effect (the number of rows repainted) is recorded — a
      // "applied but nothing changed" report is answered by whether this ran at all.
      const repainted = view.repaintInPlace?.();
      refresh?.();
      logEvent('info', 'skins', 'theme repainted', {
        transcript: repainted !== false,
        rows: view.model?.lineRecords?.().length ?? null,
        live: { palette: activePalette(), ...activeTokens() },
      });
    },
    scrollBy,
    scrollPage,
    get transcriptView() {
      return view;
    },
    screen,
    transcript,
    statusBar,
    // The working-time row (app/work-row.js): the right-aligned counter directly
    // above the meter, plus read-only views of what it currently paints.
    workBar,
    get workLine() {
      return workRow ? workRow.line : '';
    },
    get workTotals() {
      return workRow ? workRow.totals : null;
    },
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
    // The input box as an editable line (app/prompt-keys.js): the text, the caret and
    // the recallable history, so the host and the tests can see what the arrows did
    // without reaching into the wiring module.
    promptInput,
    /** The box's text, verbatim, as the caret editor sees it. */
    get promptValue() {
      return promptInput.value;
    },
    /** The caret, in grapheme clusters from the start of the box. */
    get promptCaret() {
      return promptInput.caret;
    },
    /** The caret's column in display cells, which is where the terminal cursor goes. */
    get promptCaretColumn() {
      return promptInput.caretColumn;
    },
    /** The prompts the up arrow recalls, oldest first. */
    get promptHistory() {
      return promptInput.history;
    },
    /** The editing seam itself, for callers that need the editor or the walk. */
    get promptKeys() {
      return promptInput.keys;
    },
    // Keeping the input box armed: the click on the box and the periodic check
    // (app/focus-guard.js). Exposed so the host and the tests can see a repair
    // without reaching into the wiring module.
    focusGuard,
    get focusRepairs() {
      return focusGuard ? focusGuard.repairs : 0;
    },
    // The transient notices near the top of the screen (app/notice-overlay.js).
    noticeBar,
    // The copy confirmation in the top-right corner (app/tui-toast.js): the bar itself,
    // plus read-only views of the message it shows and whether it is up.
    toastBar,
    /** The confirmation on screen right now, or '' when there is none. */
    get toastText() {
      return toastBar ? toastBar.current : '';
    },
    get toastVisible() {
      return toastBar ? toastBar.visible : false;
    },
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
    // The slash-command popup over the input box (app/slash-bar.js): the bar itself, plus
    // the two facts a caller or a test asks about — whether it is up and which rows it
    // shows. A view of the menu, never a second copy of it.
    slashBar,
    // The pinned last user message (`docs/interface/sticky-user-message`): the bar itself,
    // plus the two facts a caller asks about — whether it is up and what it says.
    sticky,
    /** True while the pinned row is on screen (the prompt has scrolled off the top). */
    get stickyVisible() {
      return Boolean(sticky) && sticky.visible === true;
    },
    /** The line the pinned row paints, or '' while nothing is pinned. */
    get stickyLine() {
      return sticky ? sticky.line : '';
    },
    /** True while the popup offering matching commands is on screen. */
    get slashOpen() {
      return slashBar ? slashBar.visible : false;
    },
    /** The rows the popup shows right now, with the selected one flagged. */
    get slashRows() {
      return slashBar ? slashBar.rows() : [];
    },
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
