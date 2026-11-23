import { sanitize } from './tui-render.js';
import { createInputHint, formatLastPromptHint, LAST_PROMPT_LABEL, HINT_COLOR } from './input-hint.js';
import { createPromptKeys } from './prompt-keys.js';

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
 * The **text and the caret** are not the widget's either: neo-blessed's textarea
 * appends every printable byte at the end and its directional keys are a `// TODO`
 * in the library, so the editing model (left/right/home/end, backspace/delete,
 * grapheme-aware) lives in `app/prompt-editor.js` and the up/down recall of what was
 * sent in `app/prompt-history.js`, bound inside the box by `app/prompt-keys.js`
 * (docs/interface/prompt-editor). This module owns only *when* a submission happens,
 * and it asks that seam to empty the box and to remember what was really sent — a
 * queued message is recallable too, because the user sent it.
 *
 * `arm()` is the single arming point and is **idempotent**, so anything that finds
 * the box unfocused or no longer reading can simply arm it again (app/focus-guard.js
 * does, on a click and on a timer) without risking a second key listener.
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
 * @param {object} [options.keys]    the caret/history seam (app/prompt-keys.js)
 * @param {Function} [options.log]   where the "[pasted N lines -> …]" notice goes
 * @param {Function} [options.refresh] repaint hook
 * @param {Function} [options.onBusySubmit] `(text) => boolean` — a submission that
 *   arrived mid-turn and was consumed by the host instead of queued (app/busy-command.js)
 */
export function createPromptInput({
  inputBox = null,
  pastes = null,
  queue = null,
  hint = null,
  keys = null,
  log = () => {},
  refresh = () => {},
  onBusySubmit = null,
} = {}) {
  // The arrows, the caret and the recallable history (app/prompt-keys.js). It adopts
  // whatever the box already holds, so an injected seam is respected.
  const promptKeys = keys || createPromptKeys({ inputBox, refresh });
  let pending = null;
  let inFlight = false;
  // Late-bound: the host that answers a command is built *after* the screen (main.js),
  // so the hook the input box asks is one it can replace once it exists.
  let busySubmit = onBusySubmit;
  let labelText = ' > ';
  // The "Last prompt: …" hint shown over an empty box (app/input-hint.js).
  const lastPromptHint = hint || createInputHint({ inputBox, refresh });

  // The tests (and the picker hand-back) read the label off the box itself.
  if (inputBox) inputBox.getLabel = () => labelText;

  /** Whether the box owns the screen's focus right now. */
  const hasFocus = () => Boolean(inputBox?.screen) && inputBox.screen.focused === inputBox;

  /**
   * Drop a keypress listener that outlived the read it was installed for.
   *
   * neo-blessed installs the textarea's key listener from a deferred tick and never
   * re-checks `_reading` inside that tick (`lib/widgets/textarea.js#Textarea`): a blur
   * landing between `readInput()` and the tick ends the read and removes the listener
   * it knows about, and the tick then installs a fresh one anyway. Arming on top of
   * that orphan leaves TWO listeners and every later keystroke is appended twice — the
   * "/sessions breaks the input" bug guarded by tests/tui-modal.test.js. Cleaning it up
   * here is what makes `arm()` safe to call at any moment, whatever the box was doing
   * before (app/focus-guard.js depends on that).
   */
  const dropOrphanReader = () => {
    if (!inputBox || inputBox._reading === true) return false;
    const orphan = inputBox.__listener;
    if (typeof orphan !== 'function') return false;
    inputBox.removeListener('keypress', orphan);
    delete inputBox.__listener;
    return true;
  };

  /**
   * Focus the box, start its single read cycle and repaint the hint over it.
   *
   * Idempotent: a box that already owns the focus is *not* focused again — blessed
   * emits a `blur` on the element being focused, which would end the very read it is
   * holding — and `readInput()` returns immediately while a read is live, so arming an
   * armed box changes nothing and can never leave two key listeners behind.
   */
  const arm = () => {
    if (!inputBox) return false;
    dropOrphanReader();
    if (!hasFocus() && typeof inputBox.focus === 'function') inputBox.focus();
    if (typeof inputBox.readInput === 'function') inputBox.readInput();
    // The editor adopts what the box holds (a hint is content, never value) and the
    // caret is placed on the text the user can type into.
    promptKeys.sync();
    lastPromptHint.apply();
    refresh();
    return true;
  };

  /** Resolve the armed question (if any) with `value` and empty the box. */
  const settle = (value) => {
    const resolve = pending;
    pending = null;
    // The box is emptied through the editing seam, so the caret and the one-line window
    // empty with it; a raw clearValue() would leave the model holding the old text.
    promptKeys.reset();
    // What was really sent is recallable with the up arrow (app/prompt-history.js).
    promptKeys.record(value);
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
    // A command is not a message for the model, so it never waits in the queue: the
    // host answers a read-only one now and refuses a mutating one outright
    // (app/busy-command.js). The box is emptied and re-armed exactly as the queued
    // path leaves it, so the next keystroke of a long turn still lands.
    if (inFlight && typeof busySubmit === 'function' && busySubmit(text)) {
      promptKeys.reset();
      promptKeys.record(text);
      arm();
      return null;
    }
    const queued = queue ? queue.enqueue(text) : null;
    promptKeys.reset();
    // A message the user really sent is part of the history even when it was queued
    // rather than answered: the up arrow recalls what was *said*, not what was replied.
    promptKeys.record(text);
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
    /**
     * Install the host's mid-turn command handler, once the host exists
     * (`app/busy-command.js`). Returns the hook it replaced, so a wiring bug is
     * observable rather than silent.
     */
    setBusySubmit(hook) {
      const previous = busySubmit;
      busySubmit = typeof hook === 'function' ? hook : null;
      return previous;
    },
    /** The editing seam: the caret, the window and the recallable history. */
    keys: promptKeys,
    /** The box's text, verbatim, as the caret editor sees it. */
    get value() {
      return promptKeys.value;
    },
    /** The caret, in grapheme clusters from the start of the box. */
    get caret() {
      return promptKeys.caret;
    },
    /** The caret's column in display cells (what the terminal cursor is placed at). */
    get caretColumn() {
      return promptKeys.caretColumn;
    },
    /** The prompts the up arrow recalls, oldest first. */
    get history() {
      return promptKeys.history.entries;
    },
    /** True while the up/down walk is in progress. */
    get isWalkingHistory() {
      return promptKeys.isWalkingHistory;
    },
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
      promptKeys.close();
      return true;
    },
    get pending() {
      return pending;
    },
    get isArmed() {
      return typeof pending === 'function';
    },
    /**
     * Whether the box is inside its read cycle right now: the second half of the
     * armed state, and the fact app/focus-guard.js asks about (a focused box that is
     * not reading swallows every keystroke).
     */
    get isReading() {
      return Boolean(inputBox) && inputBox._reading === true;
    },
    /** Whether the box owns the screen's focus right now. */
    get hasFocus() {
      return hasFocus();
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
export { createPromptKeys } from './prompt-keys.js';
export { createPromptEditor } from './prompt-editor.js';
export { createPromptHistory } from './prompt-history.js';
