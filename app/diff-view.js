import { displayWidth, clustersWithin } from './cell-width.js';

/**
 * A unified diff, laid out as two columns (backlog item 53).
 *
 * The transcript already shows a tool result as a collapsible block quoting the
 * tool's JSON, which answers *that the file changed* but not *what changed*. This
 * module turns a pair of texts into the split a reader expects from an editor: the
 * old file on the left, the new one on the right, line numbers in both gutters and
 * a marker on the rows that were removed, added or left alone.
 *
 * Three facts decide the shape, and each was measured against what the transcript
 * can already do rather than assumed:
 *
 *  - **the diff is computed on the host, never by the model.** `utils/tool-loader.js`
 *    hands the model the value `execute()` returns, so a diff carried on that value
 *    would be billed on every following call of the session. The bytes are captured
 *    here and handed to the view through `app/tool-echo.js` instead
 *    (`utils/write-journal.js`), which is a display route like every other echo.
 *  - **a split needs room.** Two numbered columns plus a gutter do not fit a narrow
 *    terminal, and a split that silently truncated a line would lose the one thing
 *    the reader opened it for, so `diffLayout()` answers a sequential layout below
 *    the measured minimum and the block falls back to today's display.
 *  - **every diff starts collapsed, like every other tool result.** The header carries
 *    the shape of the change (`+n −m`, or "new file, N lines"), so the row says that
 *    something changed and how much without painting the bytes; a click opens it
 *    (`app/transcript.js#addBlock`). Choosing by *size* instead — opening a small diff
 *    and folding a large one — would make the reader's click depend on arithmetic they
 *    cannot see.
 */

/** The least columns a two-column layout needs before it falls back to sequential. */
export const DIFF_MIN_SPLIT_WIDTH = 60;

/** How much of a gutter the line numbers may take before they are dropped. */
export const DIFF_MAX_GUTTER = 5;

/** The marker painted in the middle gutter for each row kind. */
export const DIFF_MARKERS = Object.freeze({
  context: ' ',
  removed: '-',
  added: '+',
  changed: '~',
});

/**
 * Split a text into lines without inventing a trailing one.
 *
 * `'a\nb\n'` is two lines, not three: a trailing newline ends the last line rather
 * than starting an empty one, which is the difference between a one-line file
 * showing one line and showing two.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function textLines(text) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  if (source === '') return [];
  const lines = source.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * The longest common subsequence of two line arrays, as matched index pairs.
 *
 * A plain LCS over whole lines is the right algorithm here and a word-level one
 * would be the wrong tool: the reader is comparing *lines* of a file, and a
 * character-level diff of a one-token change would paint most of the row as
 * modified. The table is `(rows + 1)` `Uint32Array`s of `cols + 1` cells, so the cost
 * is real and quadratic in the worse direction: `matchLines` is meant for a file
 * edit, not for two unrelated documents, which is why `writeDiffBlock` reports a
 * whole-file rewrite as a count instead of pairing two texts that share nothing.
 *
 * @param {string[]} before
 * @param {string[]} after
 * @returns {Array<[number, number]>} pairs of (beforeIndex, afterIndex), ascending
 */
export function matchLines(before, after) {
  const a = before;
  const b = after;
  const rows = a.length;
  const cols = b.length;

  // Length of the LCS of the suffixes, bottom-up. Two rows are enough: each row is
  // read only by the row above it, and the table is walked twice (once to fill it,
  // once to trace the path back).
  const table = new Array(rows + 1);
  for (let i = 0; i <= rows; i += 1) table[i] = new Uint32Array(cols + 1);

  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * Turn two texts into the rows a two-column view paints.
 *
 * A row is one of four kinds, and the pairing is what makes the view readable: a
 * removed line and an added line between the same two anchors are **changed** on
 * one row rather than two rows apart, so a modified function reads as a modification
 * instead of a deletion followed by an insertion. Unmatched lines pair positionally
 * while both sides have one; whatever is left over is a pure removal or addition.
 *
 * @param {string} before
 * @param {string} after
 * @returns {{kind: 'context'|'changed'|'removed'|'added', left: ?{number: number, text: string}, right: ?{number: number, text: string}}[]}
 */
export function diffRows(before, after) {
  const left = textLines(before);
  const right = textLines(after);
  const anchors = matchLines(left, right);

  const rows = [];
  const pushContext = ([i, j]) => {
    rows.push({
      kind: 'context',
      left: { number: i + 1, text: left[i] },
      right: { number: j + 1, text: right[j] },
    });
  };

  // The pair that opens the file, so a run before the first anchor is emitted with
  // the anchors that bound it rather than as a special case at the edges.
  let cursorLeft = 0;
  let cursorRight = 0;
  const emitGap = (nextLeft, nextRight) => {
    const removed = [];
    for (let i = cursorLeft; i < nextLeft; i += 1) removed.push({ number: i + 1, text: left[i] });
    const added = [];
    for (let j = cursorRight; j < nextRight; j += 1) added.push({ number: j + 1, text: right[j] });

    const paired = Math.min(removed.length, added.length);
    for (let k = 0; k < paired; k += 1) {
      rows.push({ kind: 'changed', left: removed[k], right: added[k] });
    }
    for (let k = paired; k < removed.length; k += 1) {
      rows.push({ kind: 'removed', left: removed[k], right: null });
    }
    for (let k = paired; k < added.length; k += 1) {
      rows.push({ kind: 'added', left: null, right: added[k] });
    }

    cursorLeft = nextLeft;
    cursorRight = nextRight;
  };

  for (const anchor of anchors) {
    emitGap(anchor[0], anchor[1]);
    pushContext(anchor);
    cursorLeft = anchor[0] + 1;
    cursorRight = anchor[1] + 1;
  }
  emitGap(left.length, right.length);

  return rows;
}

/**
 * One side of a row as painted: the number in its gutter, then the text.
 *
 * The text is **not** padded here. Padding is the layout's job because the column
 * width depends on the terminal, and a side padded before the width is known would
 * be padded twice.
 *
 * @param {?{number: number, text: string}} side
 * @returns {string}
 */
export function sideText(side) {
  if (!side) return '';
  return side.text;
}

/**
 * Fit one side into a column of `cells`, cutting **between grapheme clusters**.
 *
 * The same rule the queue row and the sticky bar follow: half a wide glyph or half
 * an emoji in a diff is worse than a shorter line, so the cut is made at a cluster
 * boundary and a cut line ends with `…` so the reader knows what they are not seeing.
 *
 * @param {string} text
 * @param {number} cells usable cells for the text
 * @returns {string}
 */
export function fitSide(text, cells) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const budget = Math.max(0, Number(cells) || 0);
  if (budget === 0) return '';
  if (displayWidth(source) <= budget) return source;
  if (budget === 1) return '…';
  return `${clustersWithin(source, budget - 1).join('')}…`;
}

/**
 * The widest line number the gutters must hold, for a given file size.
 *
 * @param {number} lineCount
 * @returns {number}
 */
export function gutterWidth(lineCount) {
  const digits = String(Math.max(1, Number(lineCount) || 1)).length;
  return Math.min(DIFF_MAX_GUTTER, digits);
}

/**
 * Which layout fits, and how wide its columns are.
 *
 * `split` is the reader's view and the default; `sequential` is the fallback, and
 * it is a real answer rather than a degraded one — a `-old` / `+new` list is what a
 * diff looks like on a phone. Below `DIFF_MIN_SPLIT_WIDTH` a two-column layout
 * would leave under twenty cells a side, which is where a full line of code becomes
 * an ellipsis and the view stops answering the question it was opened for.
 *
 * @param {object} [options]
 * @param {number} [options.width] the region's usable width in cells
 * @param {number} [options.lineCount] the largest line number either side reaches
 * @returns {{mode: 'split'|'sequential', gutter: number, left: number, right: number, sequential: number}}
 */
export function diffLayout({ width = 0, lineCount = 1 } = {}) {
  const total = Math.max(0, Number(width) || 0);
  const gutter = gutterWidth(lineCount);

  // Two gutters, two separators, the marker column and the padding around them.
  const chrome = gutter * 2 + 5;
  if (total >= DIFF_MIN_SPLIT_WIDTH) {
    const each = Math.floor((total - chrome) / 2);
    return { mode: 'split', gutter, left: each, right: each, sequential: 0 };
  }
  return { mode: 'sequential', gutter, left: 0, right: 0, sequential: Math.max(0, total - gutter - 3) };
}

/**
 * Paint the rows as the lines the block shows.
 *
 * `split` puts a numbered side per column and the marker between them; `sequential`
 * emits one line per side with the marker and a single gutter, which is the same
 * information at a narrower width. A side that is absent paints as blank cells of
 * the right width so the columns stay aligned down the block.
 *
 * @param {object[]} rows from `diffRows`
 * @param {object} [options]
 * @param {number} [options.width]
 * @returns {{mode: string, lines: string[]}}
 */
export function renderDiff(rows, { width = 0 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  let lineCount = 1;
  for (const row of list) {
    lineCount = Math.max(lineCount, row?.left?.number ?? 0, row?.right?.number ?? 0);
  }
  const layout = diffLayout({ width, lineCount });

  const pad = (text, cells) => {
    const fitted = fitSide(text, cells);
    const width_ = displayWidth(fitted);
    return fitted + ' '.repeat(Math.max(0, cells - width_));
  };
  const number = (side) => (side ? String(side.number).padStart(layout.gutter) : ' '.repeat(layout.gutter));

  const lines = [];
  for (const row of list) {
    const marker = DIFF_MARKERS[row.kind] ?? ' ';
    if (layout.mode === 'split') {
      lines.push(`${number(row.left)} ${pad(sideText(row.left), layout.left)}${marker}${pad(sideText(row.right), layout.right)} ${number(row.right)}`.trimEnd());
    } else {
      // Sequential: the old side above the new one, so a change keeps its two
      // versions adjacent instead of one column away.
      if (row.left) lines.push(`${number(row.left)} ${DIFF_MARKERS.removed} ${fitSide(sideText(row.left), layout.sequential)}`.trimEnd());
      if (row.right) lines.push(`${number(row.right)} ${DIFF_MARKERS.added} ${fitSide(sideText(row.right), layout.sequential)}`.trimEnd());
      if (!row.left && !row.right) lines.push('');
    }
  }
  return { mode: layout.mode, lines };
}

/**
 * What a write's block says, and what it shows.
 *
 * A block is built from the capture `utils/write-journal.js` recorded around the
 * call, so this function is pure: the bytes are handed in, never read here. Four
 * answers, and the shape of the answer is the shape of the reader's decision:
 *
 *  - **created** — the file did not exist. Nothing to compare, so the block is
 *    announced with the line count and the created file's numbered lines are inside
 *    it (`backlog item 53` asks for exactly this).
 *  - **rewritten** — the whole file changed. A diff of two unrelated texts is noise,
 *    so it is reported as a count.
 *  - **changed** — the diff, with `+n −m` in the header.
 *  - **nothing** — no capture (a shell edit, a file the journal never saw). No block
 *    at all rather than a misleading one.
 *
 * Every one of them **starts collapsed**: the family is a tool result, and a tool
 * result is a single header line until the reader clicks it
 * (`docs/interface/transcript-blocks`).
 *
 * @param {?{path: string, before: ?string, after: ?string, created: boolean}} capture
 * @param {object} [options]
 * @param {number} [options.width]
 * @returns {?{header: string, body: string, collapsed: boolean, mode: string}}
 */
export function writeDiffBlock(capture, { width = 0 } = {}) {
  if (!capture || typeof capture.path !== 'string' || !capture.path) return null;
  const { path, created } = capture;
  const before = typeof capture.before === 'string' ? capture.before : '';
  const after = typeof capture.after === 'string' ? capture.after : '';

  if (created) {
    const lines = textLines(after).length;
    return {
      header: `diff ${path} · new file, ${lines} line${lines === 1 ? '' : 's'}`,
      body: textLines(after).map((line, index) => `${String(index + 1).padStart(gutterWidth(lines))} ${line}`).join('\n'),
      collapsed: true,
      mode: 'created',
    };
  }

  const rows = diffRows(before, after);
  const changed = rows.filter((row) => row.kind !== 'context').length;
  if (changed === 0) return null;

  const rendered = renderDiff(rows, { width });
  const added = rows.filter((row) => row.kind === 'added' || (row.kind === 'changed' && row.right)).length;
  const removed = rows.filter((row) => row.kind === 'removed' || (row.kind === 'changed' && row.left)).length;

  // A rewrite is every line touched: there is no shared anchor left to read a diff
  // against, so the count is the answer and the block says so.
  const whole = rows.every((row) => row.kind !== 'context');
  return {
    header: `diff ${path} · +${added} −${removed}${whole ? ' (whole file)' : ''}${rendered.mode === 'sequential' ? ' (stacked)' : ''}`,
    body: rendered.lines.join('\n'),
    // Folded like every tool result: the header states the change, a click shows it.
    collapsed: true,
    mode: rendered.mode,
  };
}