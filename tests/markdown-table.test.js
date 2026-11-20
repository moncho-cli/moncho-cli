import test from 'node:test';
import assert from 'node:assert/strict';

import {
  splitTableRow,
  isDelimiterRow,
  alignmentOf,
  readTable,
  columnWidths,
  renderTable,
  tableAt,
} from '../app/markdown-table.js';
import { untag, visibleWidth } from '../app/tagged-text.js';
import { formatTranscript } from '../app/tui-render.js';
import { withTui, visible } from './support/tui-harness.js';

/**
 * The markdown tables a reply can contain (task-backlog: "make sure markdown is
 * properly formatted (tables look misaligned for example)").
 *
 * A reply that prints a table verbatim shows ragged pipes — every cell keeps its own
 * width, so the columns drift the moment one cell is longer than its neighbour. These
 * cases prove that a recognised table is re-laid so its separators line up, that the
 * delimiter row decides each column's alignment, that the widths are counted in
 * display cells (a wide glyph and inline markup included), and that a line which only
 * *looks* like a table stays prose.
 */

/** The columns of the `│` separators in a rendered line (its pipe positions). */
const pipeColumns = (line) => {
  const text = untag(line);
  return [...text].flatMap((ch, i) => (ch === '│' || ch === '┼' ? [i] : []));
};

/** Every rendered row must have its separators on one column per column. */
const assertAligned = (lines) => {
  const columns = lines.map((line) => pipeColumns(line).slice(0, -1).join(','));
  assert.equal(new Set(columns).size, 1, `the columns line up: ${columns.join(' | ')}`);
};

test('a markdown table is re-laid so every column lines up', () => {
  const rendered = formatTranscript([
    '| Tool | What it does |',
    '| ---- | ------------ |',
    '| read | look |',
    '| write_file | change the tree |',
  ].join('\n')).split('\n');

  assert.equal(rendered.length, 4, 'no delimiter row is painted: the pipes are the rule');
  const p = '{cyan-fg}│{/cyan-fg}';
  assert.equal(rendered[0], `${p} {bold}Tool{/bold}       ${p} {bold}What it does{/bold}    ${p}`);
  assert.equal(rendered[1], '{cyan-fg}│────────────┼─────────────────│{/cyan-fg}');
  assert.equal(rendered[2], `${p} read       ${p} look            ${p}`);
  assert.equal(rendered[3], `${p} write_file ${p} change the tree ${p}`);

  // every row has its separators on the very same columns, which is the whole point
  assertAligned(rendered);
  for (const line of rendered) assert.equal(visibleWidth(line), visibleWidth(rendered[0]));
});

test('the delimiter row carries the alignment, and a lone pipe stays prose', () => {
  // `:---` left, `---:` right, `:--:` center
  assert.equal(alignmentOf('---'), 'left');
  assert.equal(alignmentOf(':---'), 'left');
  assert.equal(alignmentOf('---:'), 'right');
  assert.equal(alignmentOf(':-:'), 'center');

  const rendered = formatTranscript([
    '| left | right | center |',
    '| :--- | ----: | :----: |',
    '| a | b | c |',
  ].join('\n')).split('\n');
  const p = '{cyan-fg}│{/cyan-fg}';
  assert.equal(rendered[2], `${p} a    ${p}     b ${p}   c    ${p}`);

  // recognised shapes
  assert.deepEqual(splitTableRow('| a | b |'), ['a', 'b']);
  assert.deepEqual(splitTableRow('a | b'), ['a', 'b']);
  assert.equal(isDelimiterRow('| --- | :--: |'), true);
  assert.equal(isDelimiterRow('| -- | text |'), false, 'a cell that is not all dashes is not a delimiter');

  // a line with a pipe but no delimiter row under it is prose, not a table: a shell
  // pipeline in a sentence must survive untouched
  const prose = 'run `cat a | grep b` to see it';
  assert.equal(formatTranscript(prose), 'run {cyan-fg}cat a | grep b{/cyan-fg} to see it');
  assert.equal(formatTranscript('a | b\nc | d').split('\n').length, 2, 'two piped lines with no rule are prose');
  // ...and a one-cell "table" is a paragraph too
  assert.equal(readTable(['| only |', '| --- |'], 0), null);
  assert.equal(tableAt(['| only |', '| --- |'], 0), null);
});

test('the table renderer measures in display cells, so a wide glyph and inline markup fit their column', () => {
  const rendered = formatTranscript([
    '| name | note |',
    '| ---- | ---- |',
    '| **bold** | 日本 |',
    '| x | ok |',
  ].join('\n')).split('\n');

  // the bold markers cost no column: `**bold**` is four cells, exactly like `name`
  const p = '{cyan-fg}│{/cyan-fg}';
  assert.equal(rendered[0], `${p} {bold}name{/bold} ${p} {bold}note{/bold} ${p}`);
  assert.equal(rendered[2], `${p} {bold}bold{/bold} ${p} 日本 ${p}`);
  assert.equal(rendered[3], `${p} x    ${p} ok   ${p}`);
  assert.equal(visibleWidth(rendered[0]), visibleWidth(rendered[2]));
  // 日本 covers four cells, so the column is exactly four wide, not two
  assert.equal(visibleWidth('日本'), 4);

  assertAligned(rendered);
});

test('renderTable() and columnWidths() pad a short row and a short body', () => {
  const table = readTable([
    '| a | bb |',
    '| --- | --- |',
    '| cccc | d |',
    '| e |',
  ].join('\n').split('\n'), 0);
  assert.deepEqual(table.header, ['a', 'bb']);
  assert.deepEqual(table.rows, [['cccc', 'd'], ['e']]);
  assert.deepEqual(columnWidths(table), [4, 2]);

  const lines = renderTable(table);
  assertAligned(lines);
  // a row missing a trailing cell still gets its separator, so the grid stays square
  assert.equal(lines.at(-1), '{cyan-fg}│{/cyan-fg} e    {cyan-fg}│{/cyan-fg}    {cyan-fg}│{/cyan-fg}');
  assert.deepEqual(renderTable({}), [], 'no header means no table');
});

test('a table in a real transcript paints aligned rows', async () => {
  await withTui(async (tui) => {
    tui.log([
      'Here is the comparison:',
      '| Tool | Family |',
      '| ---- | ------ |',
      '| read_file | read |',
      '| edit_file | write |',
    ].join('\n'));
    await new Promise((resolve) => setImmediate(resolve));

    const text = visible(tui);
    assert.match(text, /Here is the comparison:/);
    assert.match(text, /│ Tool      │ Family │/);
    assert.match(text, /│ read_file │ read   │/);
    assert.match(text, /│ edit_file │ write  │/);
    // the raw pipes are gone: the frame's own `│` replaces them
    assert.doesNotMatch(text, /\| ---- \|/);
    assert.doesNotMatch(text, /-fg\}/, 'no blessed tag leaks as text');
  });
});
