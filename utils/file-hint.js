/**
 * The *hint* form of a file's text (task-backlog: "a new hint_file tool that is very
 * similar to how read works, with the exception that all tabs and multiple continuous
 * new lines are removed. long lines are truncated as well leaving a ...[N chars after]
 * so the model can hint file contents without risking super long lines congesting the
 * context").
 *
 * A hint is not a read: it is a **sketch** of a file, cheap enough to spend context on
 * while the exact bytes do not matter yet. Every lossy step is deliberate and each one
 * is recoverable by asking `read_file` for the real page:
 *
 *  - **tabs become spaces** on a fixed grid, so an indented source file keeps its
 *    shape instead of spending a byte per tab stop;
 *  - **runs of blank lines collapse to one**, because a page of prose or a generated
 *    file spends tokens on nothing between paragraphs;
 *  - **long lines are truncated** with a `...[N chars after]` marker that reports how
 *    many characters were dropped, so the model knows the line continues *and* how
 *    much it is missing — a bare `…` would hide the size of what it did not see;
 *  - **the whole hint is capped** by a character budget, reported the same way,
 *    because a hint that silently stopped would read like a short file.
 *
 * Pure and terminal-free: a string in, a value out, no `fs` and no path. The tool
 * (`tools/hint_file.js`) owns the sandbox, the reading and the `<hint …>` delimiter;
 * `tools/read_file.js` keeps the byte-exact behaviour a hint deliberately gives up.
 */

/** Columns one tab stands for. */
export const TAB_WIDTH = 8;

/**
 * How long a line may be before it is cut: wide enough for a real code line, short
 * enough that one line cannot dominate the window the way a pasted bundle would.
 */
export const MAX_LINE_CHARS = 160;

/** The whole hint's character budget, so one file cannot fill the window. */
export const MAX_HINT_CHARS = 12 * 1024;

/** The marker template for a cut line, kept in one place so the wording cannot drift. */
export function truncationMarker(dropped) {
  return `...[${Number(dropped) || 0} chars after]`;
}

/**
 * Expand tabs to spaces on a fixed grid, the way a terminal does: a tab advances to
 * the next multiple of `width`, so columns stay aligned instead of shifting whenever
 * the text before the tab happens to be a different length.
 */
export function expandTabs(line, width = TAB_WIDTH) {
  const text = String(line ?? '');
  const step = Number.isInteger(width) && width > 0 ? width : TAB_WIDTH;
  if (!text.includes('\t')) return text;
  let out = '';
  for (const ch of text) {
    if (ch !== '\t') {
      out += ch;
      continue;
    }
    out += ' '.repeat(step - (out.length % step));
  }
  return out;
}

/**
 * Collapse every run of blank (whitespace-only) lines into a single empty line, and
 * drop the leading and trailing ones: they carry no information and they are the
 * cheapest thing to lose.
 */
export function compressBlankLines(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    const blank = line.trim() === '';
    if (blank && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(blank ? '' : line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/**
 * Cut one long line, keeping its head and reporting what was dropped:
 * `<head>...[1234 chars after]`. A line that fits is returned untouched, and the
 * marker is a **suffix**, so a line is still recognisable by what it starts with.
 *
 * `maxChars` counts the kept head only, marker excluded, so the budget means the same
 * thing whatever the dropped length happens to be.
 */
export function truncateLine(line, maxChars = MAX_LINE_CHARS) {
  const text = String(line ?? '');
  const cap = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : MAX_LINE_CHARS;
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}${truncationMarker(text.length - cap)}`;
}

/**
 * The whole hint, in the order the steps matter: normalise newlines, expand tabs,
 * collapse blank runs, cut long lines, then apply the total budget.
 *
 * The budget is applied **last** and on a line boundary, so a hint never ends in the
 * middle of a line without saying so: the kept body is followed by
 * `...[N chars after]` for the rest of the document.
 *
 * @param {string} text raw file content
 * @param {{maxLineChars?: number, maxChars?: number, tabWidth?: number}} [options]
 * @returns {{text: string, lines: number, truncated: boolean, droppedChars: number}}
 */
export function hintFileText(text, { maxLineChars = MAX_LINE_CHARS, maxChars = MAX_HINT_CHARS, tabWidth = TAB_WIDTH } = {}) {
  const source = String(text ?? '');
  let cutLines = 0;
  const prepared = compressBlankLines(source)
    .split('\n')
    .map((line) => {
      const expanded = expandTabs(line, tabWidth);
      const cut = truncateLine(expanded, maxLineChars);
      if (cut !== expanded) cutLines += 1;
      return cut;
    })
    .join('\n');

  const budget = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : MAX_HINT_CHARS;
  if (prepared.length <= budget) {
    return {
      text: prepared,
      lines: prepared === '' ? 0 : prepared.split('\n').length,
      // A line that was cut is a loss even when the document fits the budget, so
      // the hint says so: "truncated" reports what was dropped, not why.
      truncated: cutLines > 0,
      droppedChars: 0,
      cutLines,
    };
  }

  const kept = prepared.slice(0, budget);
  const boundary = kept.lastIndexOf('\n');
  const body = boundary > 0 ? kept.slice(0, boundary) : kept;
  const droppedChars = prepared.length - body.length;
  const hint = `${body}\n${truncationMarker(droppedChars)}`;
  return {
    text: hint,
    lines: hint.split('\n').length,
    truncated: true,
    droppedChars,
    cutLines,
  };
}

/**
 * What the sketch cost against the page it came from: `{before, after, savedChars}`.
 * Presentation only — `tools/hint_file.js` puts the numbers in the delimiter so the
 * model can see how much it saved and decide whether it needs the real bytes.
 */
export function hintSavings(rawText, hint) {
  const before = String(rawText ?? '').length;
  const after = String(hint ?? '').length;
  return { before, after, savedChars: Math.max(0, before - after) };
}
