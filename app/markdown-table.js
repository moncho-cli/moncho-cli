import { padVisible, visibleWidth } from './tagged-text.js';

/**
 * The markdown tables a reply can contain, rendered so their columns line up.
 *
 * A model writes tables often (a comparison, a summary, a list of files), and a
 * transcript that prints them verbatim shows ragged pipes: every cell keeps its own
 * width, so the columns drift the moment one cell is longer than its neighbour
 * (task-backlog: "make sure markdown is properly formatted (tables look misaligned for
 * example)").
 *
 * A table is recognised the way markdown defines one: a **header row** immediately
 * followed by a **delimiter row** (`| --- | :--: |`, whose colons carry the column
 * alignments). Only then is the block consumed — a lone line with a `|` in it (a
 * shell pipe in prose) is left as prose, which is what keeps the rule from firing on
 * anything but a real table.
 *
 * Pure and terminal-free: it works on already-escaped display lines and returns
 * display lines, so the rules are unit tested without a screen, and it measures with
 * `app/tagged-text.js` so inline `**bold**`/`` `code` `` and a wide glyph do not
 * throw a column off by their tag bytes or their second cell. `decorate` runs on each
 * cell *before* the widths are measured, which is how inline markup is applied
 * without its `**` markers counting as visible columns.
 *
 * A rendered row opens with the `│` of the transcript's own frame, in the palette's
 * `table` colour, so a skin moves it with everything else.
 */

/**
 * The `│` of a table frame, in the palette's `table` colour.
 *
 * The tag is **symbolic** (`{@table-fg}`): the same literal `cyan` here was frozen at
 * render time, so a skin could move every other row while a table stayed cyan. It is
 * resolved by `app/paint-tags.js` at paint time, exactly like a fence or a delimiter.
 */
const PIPE = '{@table-fg}│{/@table-fg}';

/** One delimiter cell: at least one dash, an optional colon on either side. */
const DELIMITER_CELL_RE = /^:?-{1,}:?$/;

/** Split a table row into its trimmed cells, dropping the optional outer pipes. */
export function splitTableRow(line) {
  let text = String(line ?? '').trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  return text.split('|').map((cell) => cell.trim());
}

/** True for a delimiter row (`| --- | :--: |`) with at least one cell. */
export function isDelimiterRow(line) {
  const text = String(line ?? '').trim();
  if (!text.includes('-')) return false;
  const cells = splitTableRow(text);
  return cells.length > 0 && cells.every((cell) => DELIMITER_CELL_RE.test(cell));
}

/** The alignment a delimiter cell carries: `:--` left, `--:` right, `:-:` center. */
export function alignmentOf(cell) {
  const text = String(cell ?? '').trim();
  const left = text.startsWith(':');
  const right = text.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

/** True when a line looks like part of a table (it has a cell separator). */
function hasPipe(line) {
  return String(line ?? '').includes('|');
}

/**
 * Read the table starting at `lines[index]`, or null when there is none.
 *
 * The header is `lines[index]` and the delimiter must be `lines[index + 1]` with the
 * same number of cells; the body is every following line that still carries a `|`.
 *
 * @returns {{ header: string[], align: string[], rows: string[][], end: number }|null}
 *   `end` is the index of the last line consumed, so the caller resumes after it.
 */
export function readTable(lines = [], index = 0, { decorate = (cell) => String(cell ?? '') } = {}) {
  const list = Array.isArray(lines) ? lines : [];
  const header = list[index];
  const delimiter = list[index + 1];
  if (!hasPipe(header) || !isDelimiterRow(delimiter)) return null;

  const delimiterCells = splitTableRow(delimiter);
  const headerCells = splitTableRow(header).map(decorate);
  if (headerCells.length !== delimiterCells.length) return null;
  // A one-cell "table" is a paragraph with a pipe in it, not a table.
  if (headerCells.length < 2) return null;

  const align = delimiterCells.map((cell) => alignmentOf(cell));
  const rows = [];
  let end = index + 1;
  for (let i = index + 2; i < list.length && hasPipe(list[i]) && !isDelimiterRow(list[i]); i += 1) {
    rows.push(splitTableRow(list[i]).map(decorate));
    end = i;
  }
  return { header: headerCells, align, rows, end };
}

/** The display width of every column: the widest cell of the header and the body. */
export function columnWidths({ header = [], rows = [] } = {}) {
  const columns = Math.max(header.length, ...rows.map((row) => row.length), 0);
  const widths = [];
  for (let c = 0; c < columns; c += 1) {
    let width = 0;
    for (const cell of [header[c], ...rows.map((row) => row[c])]) {
      if (cell === undefined) continue;
      width = Math.max(width, visibleWidth(cell));
    }
    widths.push(width);
  }
  return widths;
}

/** One row: `│ cell │ cell │`, every cell padded to its column and to `align`. */
function formatRow(cells, widths, align, wrap = (cell) => cell) {
  const parts = widths.map((width, c) => padVisible(wrap(cells[c] ?? ''), width, align[c]));
  return `${PIPE} ${parts.join(` ${PIPE} `)} ${PIPE}`;
}

/** The `│───┼───│` rule under the header, one segment per column, all in cyan. */
function formatSeparator(widths) {
  const segments = widths.map((width) => '─'.repeat(width + 2));
  return `{@table-fg}│${segments.join('┼')}│{/@table-fg}`;
}

/**
 * Render a table read by `readTable()` as aligned display lines: an optional bold
 * header row, the cyan rule, then one line per body row.
 */
export function renderTable(table = {}) {
  const { header = [], align = [], rows = [] } = table;
  const widths = columnWidths({ header, rows });
  // Nothing to draw: an empty table is no table at all, never a lone frame.
  if (widths.length === 0) return [];
  const out = [];
  if (header.length > 0) out.push(formatRow(header, widths, align, (cell) => `{bold}${cell}{/bold}`));
  out.push(formatSeparator(widths));
  for (const row of rows) out.push(formatRow(row, widths, align));
  return out;
}

/**
 * Read and render the table at `lines[index]` in one step, so the renderer stays a
 * single branch.
 *
 * @returns {{ lines: string[], end: number }|null}
 */
export function tableAt(lines = [], index = 0, options = {}) {
  const table = readTable(lines, index, options);
  if (!table) return null;
  return { lines: renderTable(table), end: table.end };
}
