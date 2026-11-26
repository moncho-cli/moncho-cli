/**
 * Collapsing a pasted block into a token, and restoring it exactly
 * (`docs/interface/tui`).
 *
 * A terminal hands a paste over as a **burst of ordinary keypresses**, so the input box
 * used to receive the pasted bytes one key at a time: a `\n` was silently swallowed by
 * the widget's own `setValue()` (`value.replace(/\n/g, '')`) and a `\r\n`/`\r` paste
 * submitted the message on its first line. This module is the pure half of the fix —
 * the rules that say *what a paste is*, *what the box shows instead of it*, and *how the
 * bytes come back*.
 *
 * The three rules:
 *
 *  - **a paste is a chunk that carries a line break and something besides it.** A bare
 *    `\r` (Enter) or `\n` (Ctrl+J) is a keypress, not a paste, and is left alone; a chunk
 *    with content and a break is one paste, however many lines it holds.
 *  - **the box shows a token, never the bytes**: `[pasted 3 lines #0]` — the line count
 *    for the reader and the table id for the code, so several pastes in one box stay
 *    tellable apart (`docs/interface/tui`).
 *  - **the bytes are kept verbatim** in a table entry, so expanding returns exactly what
 *    was pasted, newlines and trailing whitespace included.
 *
 * Pure and terminal-free, so the round trip and the atomic-token pattern are unit tested
 * without a screen.
 */

/**
 * Minimum number of content lines a paste must carry to be collapsed.
 *
 * One, because a single line that still ends in a line break must be collapsed too: the
 * break is either swallowed by the widget (data loss) or read as a submit (a message sent
 * halfway through a paste). The knob stays a knob — a caller may raise it to keep short
 * pastes literal.
 */
export const PASTE_THRESHOLD = 1;

/** The markers a terminal wraps a paste in when bracketed-paste mode is on. */
const BRACKETED_OPEN = '\x1b[200~';
const BRACKETED_CLOSE = '\x1b[201~';

/**
 * The token the box shows in place of a pasted block: `[pasted 3 lines #0]`.
 *
 * Two capture groups — the line count and the table id — and the `g` flag, so the same
 * pattern serves the expansion (`String#replace`), the liveness check (`matchAll`) and the
 * editor's atomic-token scan (`app/prompt-editor.js`). Never run `exec` on this shared
 * constant: a global regex carries `lastIndex` between calls.
 */
export const PASTE_TOKEN_RE = /\[pasted (\d+) lines? #(\d+)\]/g;

/** The line-break shapes a paste may carry: CRLF, a lone CR, or LF. */
const LINE_BREAK_RE = /\r\n|\r|\n/;

/**
 * Strip the bracketed-paste markers from a chunk.
 *
 * The wrapper is transport, never content: with bracketed paste on, the terminal frames
 * the paste with `\x1b[200~` … `\x1b[201~`, and those bytes must not reach the table (or
 * the model) as if the user had typed them.
 */
export function stripBracketedPaste(text) {
  const source = String(text ?? '');
  if (!source.includes(BRACKETED_OPEN) && !source.includes(BRACKETED_CLOSE)) return source;
  return source.split(BRACKETED_OPEN).join('').split(BRACKETED_CLOSE).join('');
}

/** True when the chunk carries any line break at all. */
export function hasLineBreak(text) {
  return LINE_BREAK_RE.test(String(text ?? ''));
}

/**
 * The content lines of a paste: split on any line-break shape, with **one** trailing
 * empty line dropped.
 *
 * Dropping exactly one is what makes `"a\nb\n"` two lines rather than three while keeping
 * a deliberate blank line at the end (`"a\nb\n\n"` is three). A paste copied from an
 * editor almost always carries that one trailing break.
 */
export function pasteLines(text) {
  const source = stripBracketedPaste(String(text ?? ''));
  if (!source) return [];
  const lines = source.split(LINE_BREAK_RE);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** How many content lines the paste holds (0 for an empty chunk). */
export function pasteLineCount(text) {
  return pasteLines(text).length;
}

/**
 * Whether a chunk is a paste worth collapsing.
 *
 * A line break **and** something besides it: a bare `\r`/`\n` is the Enter key and a bare
 * run of breaks carries nothing to keep, so both are left to the widget exactly as before.
 * `threshold` is the minimum content-line count (`PASTE_THRESHOLD` by default).
 */
export function isPasteChunk(text, threshold = PASTE_THRESHOLD) {
  const source = stripBracketedPaste(String(text ?? ''));
  if (!hasLineBreak(source)) return false;
  const lines = pasteLines(source);
  // Nothing but breaks: the Enter key, or a paste of blank lines. Neither is a block.
  if (lines.join('') === '') return false;
  const floor = Math.max(1, Math.trunc(Number(threshold)) || 1);
  return lines.length >= floor;
}

/** The token for a paste of `lines` content lines, held in table slot `id`. */
export function formatPasteToken(lines, id) {
  const count = Math.max(0, Math.trunc(Number(lines)) || 0);
  return `[pasted ${count} ${count === 1 ? 'line' : 'lines'} #${id}]`;
}

/**
 * The next free table id: one past the highest live id, never below `floor` (the highest
 * id this table has ever handed out).
 *
 * Monotonic rather than `entries.length`, because the table **shrinks** when a token is
 * deleted from the box: reusing a freed id would make a new paste indistinguishable from
 * the one just removed, and an old token still in the box would silently point at the new
 * bytes. The live entries alone cannot carry that memory — hence the `floor`.
 *
 * @param {Array<{id: number}>} [entries] the live table
 * @param {number} [floor] the highest id handed out before (`-1` for a fresh table)
 */
export function nextPasteId(entries = [], floor = -1) {
  let highest = Number.isFinite(Number(floor)) ? Math.trunc(Number(floor)) : -1;
  for (const entry of entries) {
    const id = Number(entry?.id);
    if (Number.isFinite(id) && id > highest) highest = id;
  }
  return highest + 1;
}

/**
 * Collapse `text` into a token, appending its bytes to `entries`.
 *
 * @param {string} text the pasted chunk, verbatim
 * @param {number} [threshold] the minimum content-line count (`PASTE_THRESHOLD`)
 * @param {Array<{id: number, text: string}>} [entries] the live table
 * @param {number} [floor] the highest id this table has already handed out (`-1` fresh)
 * @returns {{text: string, entries: Array, collapsed: boolean, id: number|null, lines: number}}
 *   the text to type into the box (the token, or the original when it is not a paste),
 *   the table with the new entry appended, and what the caller needs for its notice
 */
export function collapsePaste(text, threshold = PASTE_THRESHOLD, entries = [], floor = -1) {
  const source = String(text ?? '');
  if (!isPasteChunk(source, threshold)) {
    return { text: source, entries, collapsed: false, id: null, lines: pasteLineCount(source) };
  }
  const id = nextPasteId(entries, floor);
  const stored = stripBracketedPaste(source);
  return {
    text: formatPasteToken(pasteLines(stored).length, id),
    entries: [...entries, { id, text: stored }],
    collapsed: true,
    id,
    lines: pasteLines(stored).length,
  };
}

/**
 * Restore every token in `text` to the bytes it stands for.
 *
 * A token whose id is not in the table is left as written — the honest answer for text the
 * user typed by hand, which must never silently vanish.
 */
export function expandPastes(text, entries = []) {
  const table = new Map();
  for (const entry of entries) table.set(String(entry?.id), entry?.text);
  return String(text ?? '').replace(PASTE_TOKEN_RE, (match, _lines, id) => {
    const original = table.get(String(id));
    return typeof original === 'string' ? original : match;
  });
}

/** The table ids present in `text`, in order of appearance. */
export function pasteTokenIds(text) {
  const ids = [];
  for (const match of String(text ?? '').matchAll(PASTE_TOKEN_RE)) ids.push(Number(match[2]));
  return ids;
}
