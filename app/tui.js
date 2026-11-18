import fs from 'fs';
import blessed from 'neo-blessed';
import { RESPONSE_FILE, describeModel } from '../config/constants.js';

// Screen regions (from the bottom up):
//   input box : bottom 0, height 3 (border 'line')
//   status bar: bottom 3, height 1
//   model row : bottom 4, height 1 -> provider/model label
//   transcript: bottom 5 .. top 0 -> scrollable, bordered conversation log
const TRANSCRIPT_BOTTOM = 5;
const MODEL_BOTTOM = 4;
const STATUS_BOTTOM = 3;
const INPUT_HEIGHT = 3;

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Strip ANSI escapes / control characters so raw model output cannot break rendering. */
export function sanitize(text) {
  return String(text ?? '').replace(ANSI_RE, '').replace(CTRL_RE, '');
}

/** console.log-ish argument formatting without pulling in heavier helpers. */
export function formatArg(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

const FENCE_RE = /^\s*```\s*([\w+-]*)\s*$/;
const HEADING_RE = /^\s*(#{1,6})\s+(.*)$/;
const LIST_RE = /^(\s*)[-*+]\s+(.*)$/;
const FILE_TAG_RE = /^\s*<file\s+relative_path="([^"]*)"(?:\s+from=(\d+)\s+to=(\d+))?\s+lines=([^\s>]+)\s*>\s*$/;
const FILE_END_RE = /^\s*<\/file>\s*$/;

/** Blessed parses `{...}` as tags, so braces in untrusted text must be escaped. */
function escapeTags(text) {
  return text.replace(/[{}]/g, (ch) => (ch === '{' ? '{open}' : '{close}'));
}

/** Inline markup: **bold** and `code` (input is already sanitized + escaped). */
function inlineMarkup(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '{bold}$1{/bold}')
    .replace(/`([^`]+)`/g, '{cyan-fg}$1{/cyan-fg}');
}

function normalizePrompt(prompt) {
  const text = sanitize(prompt).replace(/\s+/g, ' ').trim();
  return text || '>';
}

/** Paste tag written into the input when a large block is collapsed. */
export const PASTE_THRESHOLD = 4;
/** Braille frames painted in the status bar while a request is in flight. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Spinner refresh interval in milliseconds. */
export const SPINNER_INTERVAL_MS = 90;

const PASTE_TAG_RE = /\[\[paste:(\d+)\]\]/g;

/**
 * Collapse a pasted block longer than `threshold` lines into one `[[paste:<id>]]`
 * tag. The original bytes are kept verbatim in `pastes`, so expandPastes() can
 * restore them exactly (round-trip safe).
 */
export function collapsePaste(text, threshold = PASTE_THRESHOLD, pastes = []) {
  const source = String(text ?? '');
  if (source.split('\n').length <= threshold) return { text: source, pastes };
  const id = pastes.length;
  return { text: `[[paste:${id}]]`, pastes: [...pastes, source] };
}

/** Expand `[[paste:<id>]]` tags back to the exact bytes they were collapsed from. */
export function expandPastes(text, pastes = []) {
  return String(text ?? '').replace(PASTE_TAG_RE, (match, id) => {
    const original = pastes[Number(id)];
    return typeof original === 'string' ? original : match;
  });
}

/**
 * Minimal markdown-ish renderer for the conversation: fenced code blocks,
 * headings, lists, bold and inline code become neo-blessed tags.
 *
 * Pure (no screen needed) so it can be unit tested without a terminal. It
 * sanitizes first, so raw model output can neither break rendering nor inject
 * tags; braces are escaped for the same reason.
 */
export function formatTranscript(text) {
  const out = [];
  let inFence = false;

  for (const raw of sanitize(text).split('\n')) {
    const fence = raw.match(FENCE_RE);
    if (fence) {
      if (inFence) {
        out.push('{cyan-fg}└─────{/cyan-fg}');
        inFence = false;
      } else {
        inFence = true;
        const lang = fence[1];
        out.push(lang ? `{cyan-fg}┌─ ${escapeTags(lang)} ─{/cyan-fg}` : '{cyan-fg}┌─────{/cyan-fg}');
      }
      continue;
    }

    if (inFence) {
      out.push(`{cyan-fg}│ ${escapeTags(raw)}{/cyan-fg}`);
      continue;
    }

    const file = raw.match(FILE_TAG_RE);
    if (file) {
      const [, filePath, from, to, lines] = file;
      const range = from && to ? ` from=${from} to=${to}` : '';
      out.push(`{cyan-fg}┌─ ${escapeTags(filePath)}${range} · lines=${escapeTags(lines)}{/cyan-fg}`);
      continue;
    }
    if (FILE_END_RE.test(raw)) {
      out.push('{cyan-fg}└─────{/cyan-fg}');
      continue;
    }

    const line = escapeTags(raw);
    const heading = line.match(HEADING_RE);
    if (heading) {
      out.push(`{bold}{underline}${inlineMarkup(heading[2])}{/underline}{/bold}`);
      continue;
    }

    const list = line.match(LIST_RE);
    if (list) {
      out.push(`${list[1]}{green-fg}•{/green-fg} ${inlineMarkup(list[2])}`);
      continue;
    }

    out.push(inlineMarkup(line));
  }

  if (inFence) out.push('{cyan-fg}└─────{/cyan-fg}');
  return out.join('\n');
}

/**
 * Build the TUI. Returns null when stdout is not a TTY (e.g. `./start.sh start`
 * runs detached, without a pty) so the caller can fall back to the line chat.
 *
 * The returned object mirrors createCLI() ({ rl, question, saveResponse, close })
 * and adds log()/setStatus() for rendering the conversation and the status bar.
 */
export function createTui(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;

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

  // Provider/model identity, resolved once at startup (env-driven).
  const modelLabel = typeof options.modelLabel === 'string' && options.modelLabel
    ? options.modelLabel
    : describeModel().label;

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

  const inputBox = blessed.textbox({
    parent: screen,
    label: ' > ',
    bottom: 0,
    left: 0,
    right: 0,
    height: INPUT_HEIGHT,
    border: { type: 'line' },
    tags: false,
    inputOnFocus: true,
    padding: { left: 1, right: 1 },
  });

  let pending = null;
  let pasteRegistry = [];
  let closed = false;
  let statusText = null;
  let spinnerTimer = null;
  let spinnerFrame = 0;
  let spinnerLabel = 'Thinking';
  let labelText = ' > ';
  inputBox.getLabel = () => labelText;

  const refresh = () => {
    if (!closed) screen.render();
  };

  const log = (...args) => {
    if (closed) return;
    const text = args.map(formatArg).join(' ');
    for (const line of formatTranscript(text).split('\n')) transcript.log(line);
    refresh();
  };

  const setStatus = (text) => {
    statusText = text;
    if (spinnerTimer) return;
    if (closed) return;
    statusBar.setContent(sanitize(text));
    refresh();
  };

  // The status bar doubles as the context-window meter: usage() renders
  // as "<used> / <max> tokens (<pct>%)".
  const setTokens = (text) => {
    setStatus(text);
  };

  // Compaction fires while a request is in flight, i.e. exactly when the status
  // bar is owned by the spinner (setStatus() returns early while spinning), so
  // the marker has to go to the transcript to be visible right away.
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
  const paintSpinner = () => {
    if (closed) return;
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
    statusBar.setContent(sanitize(`${spinnerLabel} ${frame}`));
    refresh();
  };
  // While a request is in flight the status bar shows an animated frame; the
  // last logical status text is restored once the reply lands.
  const startSpinner = (label = 'Thinking') => {
    if (closed) return;
    spinnerLabel = typeof label === 'string' && label ? label : 'Thinking';
    if (spinnerTimer) return;
    spinnerFrame = 0;
    paintSpinner();
    spinnerTimer = setInterval(() => {
      spinnerFrame += 1;
      paintSpinner();
    }, SPINNER_INTERVAL_MS);
    if (spinnerTimer && typeof spinnerTimer.unref === 'function') {
      spinnerTimer.unref();
    }
  };
  const stopSpinner = () => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    spinnerFrame = 0;
    if (statusText === null) return;
    const restore = statusText;
    statusText = null;
    setStatus(restore);
  };
  const isSpinning = () => spinnerTimer !== null;

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
  // We listen for screen-level keypresses; screen.key() would bind on
  // screen.program instead, which a synthetic screen.emit('keypress') misses.
  screen.on('keypress', (ch, key) => {
    if (!key) return;
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
  // have to repaint and keep the newest line in view.
  screen.on('resize', () => {
    transcript.setScrollPerc(100);
    refresh();
  });

  refresh();

  return {
    // createCLI()-compatible surface
    rl: {
      question: (prompt, callback) => question(prompt, callback),
    },
    question,
    saveResponse(content) {
      fs.writeFileSync(RESPONSE_FILE, content);
    },
    close() {
      if (closed) return;
      closed = true;
      pending = null;
      if (spinnerTimer) clearInterval(spinnerTimer);
      spinnerTimer = null;
      screen.destroy();
    },
    // TUI extras
    log,
    setStatus,
    setTokens,
    notifyCompaction,
    startSpinner,
    stopSpinner,
    isSpinning,
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
