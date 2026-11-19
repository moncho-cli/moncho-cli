/**
 * Key-shape helpers shared by every reader of stdin.
 *
 * The same physical key arrives in a different shape depending on who decoded it:
 *   - node:readline  -> { sequence: '\x03', name: 'c', ctrl: true }, ch = '\x03'
 *   - neo-blessed    -> { full: 'C-c', name: 'c', ctrl: true },     ch = '\x03'
 *   - escape         -> { full: 'escape', name: 'escape' },         ch = '\x1b'
 * so the predicates must not depend on a single field: the TUI and the line-based
 * CLI must recognise exactly the same interrupt keys.
 */
export const ESCAPE_CHAR = '\x1b';
export const CTRL_C_CHAR = '\x03';
export const TAB_CHAR = '\x09';

/** True for the Escape key in either decoder's shape. */
export function isEscapeKey(ch, key) {
  return ch === ESCAPE_CHAR || key?.name === 'escape' || key?.full === 'escape';
}

/** True for Ctrl+C in either decoder's shape (byte or { ctrl, name }). */
export function isCtrlC(ch, key) {
  if (ch === CTRL_C_CHAR) return true;
  return Boolean(key?.ctrl) && (key.name === 'c' || key.full === 'C-c');
}

/** The app's interrupt keys: ESC and Ctrl+C. */
export function isInterruptKey(ch, key) {
  return isEscapeKey(ch, key) || isCtrlC(ch, key);
}

/**
 * True for the Tab key in either decoder's shape.
 *
 * `\x09` is the byte a decoder delivers and `tab` is the name it gives it, but
 * Shift+Tab is a *different* byte (`\x1b[Z`, which blessed decodes to name `tab`
 * with `shift: true` and full `S-tab`). Recognising all three shapes here keeps the
 * binding free of decoder trivia, exactly like `isInterruptKey()` above: the same
 * physical key is decided once, in one pure place (`docs/interface/interrupt-controls`).
 */
export function isTabKey(ch, key) {
  if (ch === TAB_CHAR) return true;
  if (!key) return false;
  return key.name === 'tab' || key.full === 'tab' || key.full === 'S-tab';
}

/** True for Shift+Tab specifically, so a caller can tell the two directions apart. */
export function isShiftTabKey(ch, key) {
  if (!isTabKey(ch, key)) return false;
  return Boolean(key?.shift) || key?.full === 'S-tab';
}
