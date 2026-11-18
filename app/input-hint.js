import { sanitize } from './tui-render.js';

/**
 * The "Last prompt: …" hint shown over an empty input box (task-backlog: "if the
 * input box is empty, it should have a grayed italic text saying 'Last prompt:
 * .......'").
 *
 * The hint is **display only**: it is written to the widget's *content*, never to
 * its value, so it can neither be submitted nor queued, and `getValue()` stays
 * empty while it is up. It disappears with the first typed character and comes
 * back when the box is emptied again.
 *
 * Reacting to the box is what makes that automatic: neo-blessed's textarea
 * replaces its content through `setValue()` every time the value changes, which
 * emits `set content`, so the hint is repainted from that one event rather than
 * from a second key listener — a second `keypress` listener would make every
 * keystroke arrive twice (the bug `app/tui-layout.js` warns about).
 *
 * Pure and terminal-free apart from the injected widget, so the formatting and the
 * value/content rule are unit tested without a pty; `app/prompt-input.js` owns only
 * the moment to paint it.
 */

/** Prefix of the hint shown over an empty box. */
export const LAST_PROMPT_LABEL = 'Last prompt: ';

/**
 * How much of the last prompt the hint keeps. The box is one line tall and the
 * point is a reminder, not a transcript, so a long prompt is truncated and its
 * newlines are flattened away.
 */
export const HINT_MAX_CHARS = 120;

/**
 * The blessed colour of the hint. The dimmest named colour, so it recedes behind
 * real text — neo-blessed has no italic attribute (its tag vocabulary is
 * bold/underline/blink/inverse/invisible, see program.js#_attr), so the "grayed
 * italic" the backlog asked for ships as the greyed part. The deviation is stated
 * in `docs/interface/tui`, not hidden.
 */
export const HINT_COLOR = 'grey';

/** The sentinel the host loop reads; it is not a prompt and never becomes a hint. */
export const EXIT_SENTINEL = 'exit';

/**
 * The hint text for an empty box: `Last prompt: <one flattened, truncated line>`.
 *
 * Pure and safe: it sanitises first (raw control characters can never reach the
 * widget), collapses every run of whitespace so a multi-line prompt still fits on
 * one row, and returns `''` for a blank/absent prompt — an empty box with no
 * history shows nothing at all.
 */
export function formatLastPromptHint(text, maxChars = HINT_MAX_CHARS) {
  const flat = sanitize(text).replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const cap = Number(maxChars) > 0 ? Math.trunc(Number(maxChars)) : HINT_MAX_CHARS;
  return `${LAST_PROMPT_LABEL}${flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat}`;
}

/**
 * Bind the hint to one input box.
 *
 * `note(text)` records the prompt that was just sent; `apply()` paints the hint
 * when the box is empty and takes it down when it is not. The box is only greyed
 * while the hint is up, so typed text keeps the colour the layout gave it.
 *
 * @param {object} options
 * @param {object} [options.inputBox] the blessed textbox (null = a no-op)
 * @param {Function} [options.refresh] repaint hook
 * @param {number} [options.maxChars] override of the hint length cap
 */
export function createInputHint({ inputBox = null, refresh = () => {}, maxChars = HINT_MAX_CHARS } = {}) {
  let lastPrompt = '';
  // What the hint shows right now, or null while the box shows its own value.
  let paintedHint = null;
  // True while this module itself writes the content: neo-blessed reports that as
  // another 'set content', and reacting to our own write would recurse.
  let painting = false;
  // The colour the box had before a hint greyed it out (may be unset).
  const baseColor = inputBox?.style ? inputBox.style.fg : null;

  /** Write the hint (or the box value) into the widget's content. */
  const setContent = (text) => {
    if (typeof inputBox.setContent === 'function') inputBox.setContent(text);
    else inputBox.content = text;
  };

  /** Grey the box while the hint is up, and restore its own colour afterwards. */
  const setColor = (color) => {
    if (!inputBox?.style) return;
    inputBox.style.fg = color ?? null;
  };

  /** The text the hint would show right now ('' when there is no history). */
  const text = () => (lastPrompt ? formatLastPromptHint(lastPrompt, maxChars) : '');

  /**
   * Paint (or remove) the hint so the box agrees with its own value: the hint while
   * the value is empty, the value itself otherwise. Returns the hint, or null.
   */
  const apply = () => {
    if (!inputBox || painting) return null;
    const value = typeof inputBox.getValue === 'function' ? String(inputBox.getValue() ?? '') : '';
    const hint = value ? '' : text();

    if (hint) {
      const changed = paintedHint !== hint;
      paintedHint = hint;
      painting = true;
      try {
        setContent(hint);
        setColor(HINT_COLOR);
      } finally {
        painting = false;
      }
      if (changed) refresh();
      return hint;
    }

    setColor(baseColor);
    if (paintedHint !== null) {
      paintedHint = null;
      painting = true;
      try {
        setContent(value);
      } finally {
        painting = false;
      }
    }
    refresh();
    return null;
  };

  // The box replaces its own content whenever its value changes (neo-blessed's
  // textarea does that from `setValue()`), so the hint follows from that one event:
  // the first typed character takes it down, emptying the box brings it back.
  if (inputBox && typeof inputBox.on === 'function') {
    inputBox.on('set content', () => { apply(); });
  }

  return {
    apply,
    text,
    /**
     * Remember `prompt` as the last one sent and repaint. Blank text and the `exit`
     * sentinel are not prompts and leave the previous one in place.
     */
    note(prompt) {
      const value = typeof prompt === 'string' ? prompt : '';
      if (!value.trim() || value === EXIT_SENTINEL) return lastPrompt;
      lastPrompt = value;
      apply();
      return lastPrompt;
    },
    /** The prompt the hint is built from ('' before the first one is sent). */
    get lastPrompt() {
      return lastPrompt;
    },
    /** What the hint shows right now, or null while the box shows its own value. */
    get hint() {
      return paintedHint;
    },
  };
}

/**
 * Define the hint surface the host loop and the tests use onto `target`:
 * `applyHint()` repaints it, `hint` is what it shows right now (null while the box
 * shows its own value) and `lastPrompt` is the prompt it is built from.
 *
 * Kept here rather than in app/tui.js so the screen wiring stays thin, and defined
 * rather than spread for the same reason as `queueSurface`: spreading an object
 * literal evaluates its getters once, which would freeze `hint` at the value it had
 * when the TUI was built.
 */
export function hintSurface(hint, target = {}) {
  return Object.defineProperties(target, {
    applyHint: { value: () => hint.apply(), enumerable: true },
    /** The prompt the hint is built from (empty before the first one is sent). */
    lastPrompt: { get: () => hint.lastPrompt, enumerable: true },
    /** What the hint shows right now, or null while the box shows its own value. */
    hint: { get: () => hint.hint, enumerable: true },
    /** The hint bound to the box, for callers that need its whole surface. */
    inputHint: { value: hint, enumerable: true },
  });
}
