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
