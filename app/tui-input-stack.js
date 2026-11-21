import { createPromptInput } from './prompt-input.js';
import { createPromptKeys } from './prompt-keys.js';
import { createSlashMenu } from './slash-menu.js';
import { createSlashBar } from './slash-bar.js';
import { bindFocusGuard } from './focus-guard.js';

/**
 * The input region of the TUI: the box, its slash-command popup and the guard that keeps
 * the caret in it.
 *
 * They are one module because they are one thing: the box and the popup share the arrows
 * and Enter (a menu that is on screen owns them, and hands them back to the history when
 * it closes), and the focus guard exists for exactly two facts this module knows — whether
 * a question is armed and whether a request is in flight. Building them apart would mean
 * two owners for one keystroke and a third for the caret.
 *
 * The pieces are still separate and stay that way; this is the seam that gives each one
 * what it needs, in the order the dependencies force:
 *
 * ```
 *   menu  → the popup's state (app/slash-menu.js)
 *   bar   → paints the menu's rows (app/slash-bar.js)
 *   keys  → the box's key listener, which tells the menu about the text and asks it
 *           about the arrows (app/prompt-keys.js, app/prompt-menu-keys.js)
 *   input → the armed-question / capturing-box machine over those keys
 *           (app/prompt-input.js)
 *   guard → keeps the box focused and reading, on a click and on a timer
 *           (app/focus-guard.js)
 * ```
 *
 * The one circular edge is deliberate and contained: accepting a row must **submit**
 * through the input box, which does not exist yet when the key seam is built. The seam
 * calls back through a mutable reference that is filled on the next line, and that
 * reference is only ever read from a keystroke — never during construction.
 */
export function createInputStack({
  screen = null,
  inputBox = null,
  pastes = null,
  queue = null,
  log = () => {},
  refresh = () => {},
  columns = null,
  anchor = null,
  commands = () => [],
} = {}) {
  // Filled immediately below, and only read from a keystroke: see the note above.
  let promptInput = null;

  const menu = createSlashMenu({ source: commands });
  const slashBar = createSlashBar({ screen, menu, refresh, columns, anchor });

  const keys = createPromptKeys({
    inputBox,
    // **Through the bar, not the screen.** A cursor move changes no text, so nothing else
    // would repaint: the rows the bar holds are its own snapshot of the menu, and a move
    // that only rendered the screen would leave the highlight where it was. `paint()` ends
    // by refreshing the screen itself, so this is still one repaint per change.
    refresh: () => { slashBar.paint(); },
    menu,
    // The box is the popup's one source of news: every keystroke goes through
    // `publish()`, so the menu follows the text from that single hook and the bar
    // repaints from the menu (it is a view of the rows, never a second copy).
    onMenuChange: (text) => {
      menu.sync(text);
      slashBar.paint();
    },
    // Enter on a highlighted row runs that command: the submission is the same one Enter
    // on the line makes, so the box empties, the queue drains and the command is answered
    // exactly as if it had been typed in full.
    onAccept: (text) => {
      if (promptInput) promptInput.submit(text);
    },
  });

  promptInput = createPromptInput({ inputBox, pastes, queue, keys, log, refresh });

  // A submission from the widget goes through the same machine, so the two paths — Enter
  // on the line and Enter on a highlighted row — cannot disagree.
  if (inputBox && typeof inputBox.on === 'function') {
    inputBox.on('submit', (value) => {
      promptInput.submit(value);
    });
  }

  // The box keeps its focus and its read cycle on a click and on a timer: a click on
  // another region cannot take the caret away (both regions opt out of blessed's
  // autofocus, app/tui-layout.js) and any other cause of a lost focus is repaired by the
  // periodic check. It only acts while the box is *supposed* to be armed — an armed
  // question or an in-flight turn — and never while a modal owns the keyboard.
  const focusGuard = bindFocusGuard({
    inputBox,
    promptInput,
    hold: () => promptInput.isArmed || promptInput.inFlight,
  });
  focusGuard.start();

  return {
    menu,
    slashBar,
    keys,
    promptInput,
    focusGuard,
    /** Arm a question and resolve it with the next submission. */
    question: (prompt, callback) => promptInput.question(prompt, callback),
    /**
     * Tab while the popup is open: complete the highlighted command's name into the box.
     * Returns whether it took the key, which is what keeps `app/tui-keys.js` from moving
     * the mode ring on the same press.
     */
    complete: () => keys.complete(),
    /** The rows the popup is showing right now, best first. */
    get slashRows() {
      return slashBar.rows();
    },
    /** Abandon the armed question, take the popup down and stop the guard. */
    close() {
      focusGuard.close();
      slashBar.close();
      return promptInput.abandon();
    },
  };
}

export { createSlashMenu, createSlashBar };