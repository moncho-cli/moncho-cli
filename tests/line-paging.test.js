import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveLinePage, totalLines } from '../utils/line-page.js';

/**
 * The page arithmetic both read tools share (docs/agent/line-paging).
 *
 * The bug this suite pins: `read_file` counted a page in characters but reported its
 * range in lines, so a page of a long file came back labelled `from=9 to=12` while
 * holding a 300-character slice that started inside line 9. A line is the metric a
 * reader, an editor and a `grep` hit all think in, so the page counts lines.
 */

const ten = `${Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n')}\n`;

test('a text is counted in lines, a trailing newline opening the last one', () => {
  assert.equal(totalLines(''), 0, 'an empty file has no lines');
  assert.equal(totalLines('a'), 1);
  assert.equal(totalLines('a\n'), 2, '"a\\n" is line 1 plus the empty line after it');
  assert.equal(totalLines(ten), 11);
});

test('offset is a 1-based line number and limit a number of lines', () => {
  const page = resolveLinePage(ten, { offset: 4, limit: 3 });
  assert.deepEqual(
    { from: page.from, to: page.to, lines: page.lines, total: page.total, text: page.text },
    { from: 4, to: 6, lines: 3, total: 11, text: 'l4\nl5\nl6' },
    'lines 4..6 are exactly the three lines named, whatever their byte length',
  );
});

test('a page is whole lines, so the range it names is the range it returned', () => {
  // Uneven line lengths are where a character page and a line page diverge: the old
  // arithmetic started mid-line and labelled the fragment as if the line were whole.
  const ragged = ['a', 'b'.repeat(40), 'c', 'd'.repeat(2), 'e'].join('\n');
  const page = resolveLinePage(ragged, { offset: 2, limit: 1 });
  assert.equal(page.text, 'b'.repeat(40), 'line 2 arrives complete, never cut');
  assert.deepEqual([page.from, page.to], [2, 2]);
});

test('a negative offset counts back from the last line', () => {
  assert.equal(resolveLinePage(ten, { offset: -2 }).text, 'l10\n', '-2 is the last two lines');
  assert.equal(resolveLinePage(ten, { offset: -1 }).text, '', '-1 is the empty final line');
  assert.equal(resolveLinePage('only line', { offset: -1 }).text, 'only line', 'a one-line file');
  assert.equal(resolveLinePage(ten, { offset: -99 }).from, 1, 'a very negative offset starts at line 1');
});

test('an omitted limit reads to the end and a page that ends there keeps the last newline', () => {
  const page = resolveLinePage(ten, { offset: 9 });
  assert.equal(page.to, page.total);
  assert.equal(page.text, 'l9\nl10\n', 'the file\'s own trailing newline survives');
});

test('an offset past the end is an empty page, never a clamp', () => {
  const page = resolveLinePage(ten, { offset: 99, limit: 5 });
  assert.equal(page.empty, true);
  assert.equal(page.from, undefined, 'an empty page reports no range rather than a made-up one');
  assert.equal(page.to, undefined);
  assert.equal(page.lines, 0);
  assert.equal(page.text, '');
  assert.equal(page.total, 11, 'the size is still reported, so the caller learns the bounds');
});

test('a zero limit and an empty file are both empty pages', () => {
  assert.equal(resolveLinePage(ten, { offset: 1, limit: 0 }).empty, true);
  const empty = resolveLinePage('', {});
  assert.deepEqual([empty.empty, empty.total, empty.lines], [true, 0, 0]);
});