/**
 * One page of a text file, measured in **lines**.
 *
 * Both read tools page the same way — `tools/read_file.js` for the bytes and
 * `tools/hint_file.js` for the sketch — so the arithmetic lives here once and the two
 * can never disagree about what "lines 3 to 8" means.
 *
 * The band used to be described in two coordinate systems at once: `offset`/`limit`
 * counted *characters* while the `<file … from=… to=… lines=…>` delimiter reported
 * *lines* (task-backlog item 63). A page therefore started at a character inside a line
 * and was labelled as if that line were complete, so the model could not compute its next
 * `offset` from what it had been told, and a page of a long file came back as
 * `from=9 to=12` — a whole-line range that was really a 300-character slice.
 *
 * A line is the metric a reader and an editor both think in: `edit_file` refuses a search
 * whose text does not match, `grep` answers in `path:line`, and the model's own notes are
 * written as "line 47". So the page counts lines and nothing here can be off by a
 * character. Three rules make the answer unambiguous:
 *
 *  - **`offset` is a 1-based line number** (the first line is 1), and a negative offset
 *    counts back from the last line — `-1` is the final line, not the bytes before the
 *    final newline;
 *  - **`limit` is a number of lines**, and omitted means "to the end of the file";
 *  - **the page is whole lines**, so `from` and the numbered body cannot disagree, and a
 *    page that starts past the end is reported empty rather than clamped onto some other
 *    region the caller never asked for.
 *
 * Pure text in, text out: no filesystem, no tool, so every rule is unit tested directly.
 */

/**
 * How many lines a text holds, by the split-on-newline convention every read reports.
 *
 * A trailing newline opens a final empty line (`"a\n"` is two lines), which is the
 * convention the `<file … lines=…>` tag has always counted with, so keeping it here means
 * the tag and the page are measured the same way. An empty file has no lines at all.
 */
export function totalLines(text) {
  const source = String(text ?? '');
  return source === '' ? 0 : source.split('\n').length;
}

/**
 * Resolve a page of `text` to whole lines.
 *
 * @param {string} text the file's content, exactly as read
 * @param {{offset?: number, limit?: number}} [page] `offset` is a 1-based line number
 *   (negative counts from the end), `limit` a number of lines (omitted: to the end)
 * @returns {{from: number|undefined, to: number|undefined, total: number, lines: number,
 *   text: string, empty: boolean}} the page. `from`/`to` are omitted when the page is
 *   empty, because an empty page has no range to report — a fabricated one is what a
 *   reader would trust and be wrong about.
 */
export function resolveLinePage(text, { offset = 1, limit } = {}) {
  const source = String(text ?? '');
  const total = totalLines(source);
  const all = total === 0 ? [] : source.split('\n');

  let from = Number.isInteger(offset) && offset !== 0 ? offset : 1;
  // A negative offset counts back from the last line, so -1 names the final line.
  if (from < 0) from = total + from + 1;
  from = Math.max(1, from);

  const count = Number.isInteger(limit) && limit >= 0 ? limit : null;
  const to = count === null ? total : Math.min(total, from + count - 1);

  const empty = total === 0 || from > total || count === 0;
  if (empty) return { from: undefined, to: undefined, total, lines: 0, text: '', empty: true };

  const page = all.slice(from - 1, to);
  // Joining the slice reproduces the file's own bytes for that range: a page that ends on
  // the last line keeps the file's trailing newline, and one that does not keeps none.
  return { from, to, total, lines: page.length, text: page.join('\n'), empty: false };
}