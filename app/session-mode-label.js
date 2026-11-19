import { sanitize, escapeTags } from './tui-render.js';
import { modeStateKey, formatModeLabel, modeColor, DEFAULT_MODE, MODES } from './session-mode.js';

/**
 * The mode label at the leftmost cell of the model row.
 *
 * The session's intent mode is the one piece of state that decides *what the
 * session may do*, so it belongs on screen without a command and without a
 * keystroke: `{yellow-fg}Work{/yellow-fg} openrouter · deepseek`. The row is the
 * model row's own leftmost cell rather than a new region, so no layout number
 * moves and the identity keeps the place it always had.
 *
 * Pure composition, injected painting: `formatModeRow()` returns a string, so the
 * order, the escaping and the colour are unit tested without a terminal, while
 * `createModeRow()` is the thin binding that repaints a widget **only on an
 * accepted** mode change (`app/session-mode.js` notifies on those alone) — a
 * refused `Tab` under the `work:on` lock must leave the row exactly as it was.
 *
 * @see docs/interface/modes
 */

/** The gap between the mode label and the model identity. */
export const MODE_LABEL_SEPARATOR = ' ';

/**
 * The state a row shows before any session mode is known.
 *
 * It is `DEFAULT_MODE` — a session opens in `work` — and deliberately not a
 * hard-coded `chat`: a row that announced `Chat` while the session really is `Work`
 * would be the one thing this label exists to prevent, a screen and a session
 * disagreeing about what may touch a file. `normalizeMode()`'s `chat` fallback is a
 * different rule: a *junk* stored mode still lands in the read-only state.
 */
export function defaultModeState() {
  return {
    mode: DEFAULT_MODE,
    work: false,
    key: modeStateKey(DEFAULT_MODE, false),
    label: formatModeLabel(DEFAULT_MODE, false),
    color: modeColor(DEFAULT_MODE, false),
  };
}

/**
 * One state's label as a blessed tag string, in that state's bright colour.
 *
 * Both halves are sanitised and the braces are escaped: the label and the colour
 * travel through a screen that parses `{...}`, so neither may smuggle a tag of its
 * own. An unusable colour falls back to the default state's own colour instead of a
 * broken tag.
 */
export function formatModeTag(state = {}) {
  const source = state && typeof state === 'object' ? state : {};
  const rawColor = sanitize(source.color ?? '');
  const color = /^[a-z][a-z-]*$/.test(rawColor) ? rawColor : modeColor(DEFAULT_MODE, false);
  const label = escapeTags(sanitize(source.label ?? formatModeLabel(DEFAULT_MODE, false)));
  return `{${color}-fg}${label}{/${color}-fg}`;
}

/**
 * The whole model row: the coloured mode label at the very left, then the model
 * identity. A missing identity leaves the label alone — never a trailing space —
 * and the identity is sanitised and escaped because a model name is
 * environment-driven text a screen must not interpret.
 */
export function formatModeRow(state = {}, modelLabel = '') {
  const label = escapeTags(sanitize(modelLabel));
  const tag = formatModeTag(state);
  return label ? `${tag}${MODE_LABEL_SEPARATOR}${label}` : tag;
}

/**
 * Bind the row to a `paint(line)` hook (a blessed box's `setContent`).
 *
 * `mode` may be a `createSessionMode()` object: the row then subscribes to it and
 * repaints itself on every accepted change, and `close()` drops the subscription
 * so tearing a screen down never leaves a listener behind. Without one the row
 * still paints a state — the passed one, or the `DEFAULT_MODE` default — so the
 * leftmost cell is never blank.
 */
export function createModeRow({
  paint = null,
  modelLabel = '',
  mode = null,
  state = null,
} = {}) {
  const subscribed = mode && typeof mode.subscribe === 'function' ? mode : null;
  let current = state
    || (mode && typeof mode.describe === 'function' ? mode.describe() : null)
    || defaultModeState();
  let unsubscribe = () => {};

  const emit = () => {
    const line = formatModeRow(current, modelLabel);
    if (typeof paint === 'function') paint(line);
    return line;
  };

  if (subscribed) {
    unsubscribe = subscribed.subscribe((next) => {
      current = next;
      emit();
    });
  }

  return {
    /** Paint the row for the state it currently holds. */
    render: emit,
    /** Replace the state by hand (a caller that does not drive a session mode). */
    setState(next) {
      current = next || defaultModeState();
      return emit();
    },
    /** The state the row is painting; never null once the row exists. */
    get state() {
      return current;
    },
    /** Drop the subscription (screen teardown). */
    close: () => unsubscribe(),
  };
}

export { MODES };
