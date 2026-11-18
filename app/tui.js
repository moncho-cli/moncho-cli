import blessed from 'neo-blessed';
import { describeModel } from '../config/constants.js';
import { isInterruptKey } from '../utils/keys.js';
import { createStatusRow, SPINNER_FRAMES, SPINNER_INTERVAL_MS } from './status-row.js';
import { createLayout, TRANSCRIPT_BOTTOM, MODEL_BOTTOM, STATUS_BOTTOM, INPUT_HEIGHT } from './tui-layout.js';
import { createTranscriptView } from './transcript-view.js';
import { chooseLabel } from './tui-modal.js';
import {
  sanitize,
  formatArg,
  formatTranscript,
  composeStatusRow,
  collapsePaste,
  expandPastes,
  PASTE_THRESHOLD,
} from './tui-render.js';

// The pure helpers live in ./tui-render.js, the transcript model in
// ./transcript.js (bound to the widget by ./transcript-view.js), the region
// layout in ./tui-layout.js and the status-row bookkeeping in ./status-row.js.
// They are all re-exported here so app/tui.js stays the single entry point every
// importer (and the specs) already use.
export { sanitize, formatArg, formatTranscript, composeStatusRow, collapsePaste, expandPastes, PASTE_THRESHOLD };
export { SPINNER_FRAMES, SPINNER_INTERVAL_MS };
export { TRANSCRIPT_BOTTOM, MODEL_BOTTOM, STATUS_BOTTOM, INPUT_HEIGHT };

function normalizePrompt(prompt) {
  const text = sanitize(prompt).replace(/\s+/g, ' ').trim();
  return text || '>';
}

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

  const { transcript, statusBar, modelBar, inputBox } = createLayout({ screen, modelLabel });

  let pending = null;
  let pasteRegistry = [];
  let closed = false;
  let labelText = ' > ';
  inputBox.getLabel = () => labelText;

  const refresh = () => {
    if (!closed) screen.render();
  };

  // The transcript is a model + view pair: the model holds the entries (plain
  // lines and collapsible blocks), the view paints them and resolves clicks.
  const view = createTranscriptView({ widget: transcript, refresh });

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
  // bar's left slot is owned by the spinner, so the marker has to go to the
  // transcript to be visible right away.
  let compactionMarks = 0;
  const notifyCompaction = (stats) => {
    if (closed) return;
    const count = Number(stats?.compactions) || 0;
    if (count <= compactionMarks) return;
    compactionMarks = count;
    const last = { ...(stats?.lastCompaction || {}) };
    const older = Number(last.olderChunks) || 0;
    const kept = Number(last.keptChunks) || 0;
    const tokens =
      last.olderTokens != null && last.afterTokens != null
        ? ` (${last.olderTokens} -> ${last.afterTokens} tokens)`
        : '';
    log(
      `[Context] compaction fired: ${older} older chunk(s) -> summary, kept ${kept} newest chunk(s)${tokens}.`,
    );
  };

  const settle = (value) => {
    const resolve = pending;
    pending = null;
    inputBox.clearValue();
    if (typeof resolve === 'function') resolve(value);
    refresh();
  };

  inputBox.on('submit', (value) => {
    const raw = typeof value === 'string' ? value : '';
    const collapsed = collapsePaste(raw, PASTE_THRESHOLD, pasteRegistry);
    if (collapsed.pastes.length !== pasteRegistry.length) {
      pasteRegistry = collapsed.pastes;
      log(`[pasted ${raw.split('\n').length} lines -> ${collapsed.text}]`);
    }
    settle(expandPastes(collapsed.text, pasteRegistry));
  });

  const question = (prompt, callback) => {
    labelText = ` ${normalizePrompt(prompt)} `;
    inputBox.setLabel(labelText);
    return new Promise((resolve) => {
      pending = (value) => {
        if (typeof callback === 'function') callback(value);
        resolve(value);
      };
      inputBox.focus();
      if (typeof inputBox.readInput === 'function') inputBox.readInput();
      refresh();
    });
  };

  // Scrolling must work even while the input box owns the focus.
  const scrollBy = (amount) => {
    transcript.scroll(amount);
    refresh();
  };

  // A click on the transcript toggles the tool-result block under the cursor
  // (expand, then collapse again on the next click).
  transcript.on('click', (data) => {
    view.clickAt(data);
  });

  // Escape / Ctrl+C must be taken before blessed dispatches them. While the input
  // box is reading, screen-level listeners are skipped and textarea turns Escape
  // into its own 'cancel' event: the box blurs and the armed question() promise is
  // never resolved. Handling the key at the program level and locking key dispatch
  // for that single event keeps the box reading while the host reacts.
  const forwardInterrupt = (ch, key) => {
    if (!isInterruptKey(ch, key)) return false;
    screen.lockKeys = true;
    queueMicrotask(() => {
      screen.lockKeys = false;
    });
    if (onInterrupt) onInterrupt();
    return true;
  };
  screen.program.prependListener('keypress', forwardInterrupt);
  // We listen for screen-level keypresses; screen.key() would bind on
  // screen.program instead, which a synthetic screen.emit('keypress') misses.
  screen.on('keypress', (ch, key) => {
    if (!key) return;
    if (isInterruptKey(ch, key)) {
      if (onInterrupt) onInterrupt();
      return;
    }
    const name = key.full || key.name;
    if (name === 'pageup' || name === 'S-up') {
      scrollBy(-1);
    } else if (name === 'pagedown' || name === 'S-down') {
      scrollBy(1);
    } else if (name === 'home') {
      transcript.setScrollPerc(0);
      refresh();
    } else if (name === 'end') {
      transcript.setScrollPerc(100);
      refresh();
    }
  });

  // Regions are laid out relatively, so blessed relayouts them on resize; we only
  // have to repaint the status row (whose width changed) and keep the newest line
  // in view.
  screen.on('resize', () => {
    transcript.setScrollPerc(100);
    statusRow.render();
  });

  statusRow.render();

  return {
    // createCLI()-compatible surface
    rl: {
      question: (prompt, callback) => question(prompt, callback),
    },
    question,
    // Settle an armed question with the 'exit' sentinel the host loop understands.
    exit() {
      if (typeof pending !== 'function') return false;
      settle('exit');
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      pending = null;
      view.close();
      screen.program.removeListener('keypress', forwardInterrupt);
      statusRow.dispose();
      screen.destroy();
    },
    // TUI extras
    log,
    logBlock,
    setStatus,
    setTokens,
    notifyCompaction,
    startSpinner: (label) => statusRow.startSpinner(label),
    stopSpinner: () => statusRow.stopSpinner(),
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
    async choose(labels = [], { title = 'Select' } = {}) {
      return chooseLabel({
        screen,
        labels,
        title,
        render: refresh,
        onOpenChange: (open) => {
          if (!open) inputBox.focus();
        },
      });
    },
    collapsePaste(text) {
      const collapsed = collapsePaste(text, PASTE_THRESHOLD, pasteRegistry);
      pasteRegistry = collapsed.pastes;
      return collapsed.text;
    },
    expandPastes(text) {
      return expandPastes(text, pasteRegistry);
    },
    get pastes() {
      return pasteRegistry;
    },
    refresh,
    scrollBy,
    screen,
    transcript,
    statusBar,
    modelBar,
    inputBox,
    get isClosed() {
      return closed;
    },
    get modelLabel() {
      return modelLabel;
    },
  };
}
