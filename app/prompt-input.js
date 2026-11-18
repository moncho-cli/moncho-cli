import { sanitize } from './tui-render.js';
import { createInputHint, formatLastPromptHint, LAST_PROMPT_LABEL, HINT_COLOR } from './input-hint.js';

/**
 * The input box as a two-state machine: an **armed question** between turns, or a
 * **capturing box** while a request is in flight.
 *
 * Between turns `question()` arms the box and the answer settles the armed promise,
 * exactly as before. While a request is in flight there is no armed question — the
 * host loop is busy in `processInput()` — so a submission must not vanish: it is
 * handed to the queue (task.md: "send at any moment … queued … injected when
 * possible") and the box stays armed for the next one.
 *
 * A third, purely cosmetic state is the **hint**: while the box holds no text it
 * shows what the last prompt was, greyed out (task-backlog: "if the input box is
 * empty, it should have a grayed italic text saying 'Last prompt: .......'").
 * The formatting and the value/content rule live in `app/input-hint.js`, which is
 * pure; this module only decides *when* to paint it.
 *
 * Kept apart from app/tui.js so the screen wiring stays thin, and free of
 * neo-blessed: the caller injects the box, the paste table, the queue and a log,
 * so every rule below is unit testable without a terminal.
 */

/** The label of the box: the prompt, flattened to a single line. */
export function normalizePrompt(prompt) {
  const text = sanitize(prompt).replace(/\s+/g, ' ').trim();
  return text || '>';
}

/**
 * @param {object} options
 * @param {object} options.inputBox  the blessed textbox
 * @param {object} [options.pastes]  the paste table (app/paste-registry.js)
 * @param {object} [options.queue]   the pending-message queue (app/message-queue.js)
 * @param {object} [options.hint]    the last-prompt hint (app/input-hint.js)
 * @param {Function} [options.log]   where the "[pasted N lines -> …]" notice goes
 * @param {Function} [options.refresh] repaint hook
 */
export function createPromptInput({
  inputBox = null,
  pastes = null,
  queue = null,
  hint = null,
  log = () => {},
  refresh = () => {},
} = {}) {
  let pending = null;
  let inFlight = false;
  let labelText = ' > ';
  // The "Last prompt: …" hint shown over an empty box (app/input-hint.js).
  const lastPromptHint = hint || createInputHint({ inputBox, refresh });

  // The tests (and the picker hand-back) read the label off the box itself.
  if (inputBox) inputBox.getLabel = () => labelText;

  /** Focus the box, start its single read cycle and repaint the hint over it. */
  const arm = () => {
    if (!inputBox) return false;
    if (typeof inputBox.focus === 'function') inputBox.focus();
    if (typeof inputBox.readInput === 'function') inputBox.readInput();
    lastPromptHint.apply();
    refresh();
    return true;
  };

  /** Resolve the armed question (if any) with `value` and empty the box. */
  const settle = (value) => {
    const resolve = pending;
    pending = null;
    if (inputBox && typeof inputBox.clearValue === 'function') inputBox.clearValue();
    // The box is empty again, so the hint for the prompt just sent takes over.
    lastPromptHint.note(value);
    if (typeof resolve === 'function') resolve(value);
    refresh();
    return value;
  };

  /**
   * The bytes one submission stands for: a long paste collapses into a tag for the
   * box (the original bytes stay in the paste table) and expands back verbatim, so
   * the model receives exactly what the user typed.
   */
  const prepare = (value) => {
    const raw = typeof value === 'string' ? value : '';
    const collapsed = pastes ? pastes.collapse(raw) : { text: raw, collapsed: false };
    if (collapsed.collapsed) log(`[pasted ${raw.split('\n').length} lines -> ${collapsed.text}]`);
    return pastes ? pastes.expand(collapsed.text) : collapsed.text;
  };

  /**
   * Handle one Enter: settle the armed question when there is one — the idle case,
   * where the box behaves exactly as it does today — otherwise queue the message.
   * A request is in flight for the whole of `processInput()` and the box is
   * deliberately still armed then, so a submission must never resolve a question
   * nobody armed, nor be dropped on the floor. A blank message is not queued (there
   * is nothing to inject) and leaves the box empty.
   */
  const submit = (value) => {
    const text = prepare(value);
    if (typeof pending === 'function') {
      settle(text);
      return null;
    }
    const queued = queue ? queue.enqueue(text) : null;
    if (inputBox && typeof inputBox.clearValue === 'function') inputBox.clearValue();
    // Enter ends the box's read cycle (neo-blessed's textarea drops its listener on
    // submit), so the box is armed again here: otherwise the very next keystroke of
    // a long turn would be lost — the bug this queue exists to fix.
    arm();
    return queued;
  };

  return {
    submit,
    settle,
    arm,
    /** Paint the last-prompt hint (or the box's own value) right now. */
    applyHint: () => lastPromptHint.apply(),
    /** The prompt the hint is built from ('' before the first one is sent). */
    get lastPrompt() {
      return lastPromptHint.lastPrompt;
    },
    /** What the hint shows right now, or null while the box shows its own value. */
    get hint() {
      return lastPromptHint.hint;
    },
    /** The hint bound to this box, for callers that need its surface. */
    get inputHint() {
      return lastPromptHint;
    },
    normalizePrompt,
    /** Arm a question and resolve it with the next submission. */
    question(prompt, callback) {
      labelText = ` ${normalizePrompt(prompt)} `;
      if (inputBox && typeof inputBox.setLabel === 'function') inputBox.setLabel(labelText);
      return new Promise((resolve) => {
        pending = (value) => {
          if (typeof callback === 'function') callback(value);
          resolve(value);
        };
        arm();
      });
    },
    /** Settle an armed question with the 'exit' sentinel the host loop reads. */
    exit() {
      if (typeof pending !== 'function') return false;
      settle('exit');
      return true;
    },
    /** The turn started: the box keeps reading, and a submission is queued. */
    startFlight() {
      inFlight = true;
      return arm();
    },
    /** The turn ended: the next submission settles the next question again. */
    endFlight() {
      inFlight = false;
      return false;
    },
    /** Drop the armed question without resolving it (screen teardown). */
    abandon() {
      pending = null;
      inFlight = false;
      return true;
    },
    get pending() {
      return pending;
    },
    get isArmed() {
      return typeof pending === 'function';
    },
    get inFlight() {
      return inFlight;
    },
    get label() {
      return labelText;
    },
  };
}

export { createInputHint, formatLastPromptHint, LAST_PROMPT_LABEL, HINT_COLOR };
