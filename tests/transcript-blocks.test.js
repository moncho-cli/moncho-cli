import test from 'node:test';
import assert from 'node:assert/strict';

import { createTui } from '../app/tui.js';
import {
  TranscriptModel,
  COLLAPSE_THRESHOLD_CHARS,
  COLLAPSED_MARKER,
  EXPANDED_MARKER,
  formatCharCount,
  formatBlockHeader,
  blockLines,
  clickRow,
  blockAtClick,
} from '../app/transcript.js';
import { withTui, visible, plainText } from './support/tui-harness.js';

/**
 * Screen row of a display line inside the transcript: the widget origin, plus its
 * border/padding, plus the scroll base — blessed's `childBase`, which is what the
 * click math in app/transcript.js uses (`getScroll()` also adds `childOffset`).
 */
function rowOf(tui, displayLine) {
  return tui.transcript.lpos.yi + tui.transcript.itop + (displayLine - (tui.transcript.childBase || 0));
}

/** Click the transcript on a display line, exactly as neo-blessed would. */
function clickLine(tui, displayLine) {
  return tui.clickTranscript({ x: tui.transcript.lpos.xi + 2, y: rowOf(tui, displayLine) });
}

test('the transcript model collapses long blocks and keeps the payload verbatim', () => {
  const model = new TranscriptModel();
  const body = 'a\nb\nc';

  const block = model.addBlock({ header: '  [tool Output]', body });
  assert.equal(block.collapsed, true, 'a multi-line payload starts collapsed');
  assert.equal(block.chars, body.length);
  assert.equal(model.lines.length, 1, 'a collapsed block paints one line');

  // the size label and the marker are part of the header
  assert.equal(formatCharCount(body.length), '5 char response');
  assert.match(model.lines[0], /5 char response/);
  assert.ok(model.lines[0].startsWith(COLLAPSED_MARKER));

  // expanding reveals the payload, line by line, without altering it
  assert.equal(model.expandBlock(block.id), block);
  assert.equal(block.collapsed, false);
  assert.ok(model.lines[0].startsWith(EXPANDED_MARKER));
  assert.deepEqual(model.lines.slice(1), ['a', 'b', 'c']);
  assert.equal(block.body, body, 'the payload is stored verbatim');

  // ... and collapsing again returns to the single header line
  model.collapseBlock(block.id);
  assert.equal(model.lines.length, 1);
  assert.equal(model.toggleBlock(block.id), block);
  assert.equal(block.collapsed, false);
  assert.equal(model.toggleBlock('nope'), null, 'an unknown id changes nothing');
  assert.equal(model.expandBlock('nope'), null);
  assert.equal(model.collapseBlock('nope'), null);
});

test('a short single-line result is not hidden behind a click', () => {
  const model = new TranscriptModel();

  const short = model.addBlock({ header: '  [tool Output]', body: 'ok' });
  assert.equal(short.collapsed, false);
  assert.ok(short.chars <= COLLAPSE_THRESHOLD_CHARS);
  assert.deepEqual(model.lines, ['▾   [tool Output] — 2 char response (click to collapse)', 'ok']);

  // one very long line is worth collapsing even though it is a single line
  const long = model.addBlock({ header: '  [tool Output]', body: 'x'.repeat(COLLAPSE_THRESHOLD_CHARS + 1) });
  assert.equal(long.collapsed, true);

  // an explicit choice always wins
  assert.equal(model.addBlock({ header: 'h', body: 'a\nb', collapsed: false }).collapsed, false);
  assert.equal(model.addBlock({ header: 'h', body: 'a', collapsed: true }).collapsed, true);
});

test('plain lines and blocks keep their order and their line ranges', () => {
  const model = new TranscriptModel();
  model.addLine('before');
  const block = model.addBlock({ header: '  [tool Output]', body: 'one\ntwo' });
  model.addLine('after');

  assert.deepEqual(model.lines.slice(0, 1), ['before']);
  assert.equal(model.lines.at(-1), 'after');
  assert.deepEqual(model.rangeOf(block), { start: 1, end: 2 }, 'collapsed: one line');
  assert.equal(model.blockAtLine(0), null, 'prose belongs to no block');
  assert.equal(model.blockAtLine(1), block, 'the header row belongs to the block');
  assert.equal(model.blockAtLine(2), null, 'the line after the block is prose');

  model.expandBlock(block.id);
  assert.deepEqual(model.rangeOf(block), { start: 1, end: 4 });
  assert.equal(model.blockAtLine(3), block, 'every payload line belongs to the block');
  assert.equal(model.blockAtLine(4), null);
  assert.equal(model.blockAtLine(-1), null);

  model.clear();
  assert.deepEqual(model.lines, []);
  assert.equal(model.blockAtLine(0), null);
});

test('clickRow() and blockAtClick() map a screen click onto a block', () => {
  const pos = { xi: 0, yi: 5 };
  // row = y - yi - itop (border + padding), plus the scroll base
  assert.equal(clickRow({ pos, data: { x: 2, y: 6 }, itop: 1 }), 0);
  assert.equal(clickRow({ pos, data: { x: 2, y: 9 }, itop: 1 }), 3);
  assert.equal(clickRow({ pos, data: { x: 2, y: 9 }, itop: 1, childBase: 4 }), 7);
  // above the content, or with nothing to measure against
  assert.equal(clickRow({ pos, data: { x: 2, y: 5 }, itop: 1 }), -1);
  assert.equal(clickRow({ pos, data: { x: 2, y: 4 } }), -1);
  assert.equal(clickRow({}), -1);

  const model = new TranscriptModel();
  model.addLine('prose');
  const block = model.addBlock({ header: '  [tool Output]', body: 'one\ntwo' });

  // a click on the block header (display line 1 => screen row 5 + 1 + 1)
  assert.equal(blockAtClick({ model, data: { x: 1, y: 7 }, pos, itop: 1 }), block);
  // a click on the prose above it
  assert.equal(blockAtClick({ model, data: { x: 1, y: 6 }, pos, itop: 1 }), null);
  // wrapped lines are mapped back through blessed's fake->real table
  assert.equal(
    blockAtClick({ model, data: { x: 1, y: 7 }, pos, itop: 1, rtof: [0, 1, 1] }),
    block,
    'a wrapped row still resolves to the block',
  );
  assert.equal(blockAtClick({ model, data: { x: 1, y: 7 }, pos, itop: 1, rtof: [0, 0, 1] }), null);
  // scrolling down moves the block up on screen
  assert.equal(blockAtClick({ model, data: { x: 1, y: 6 }, pos, itop: 1, childBase: 1 }), block);
});

test('a tool result is collapsed by default and says "X char response" inline', async () => {
  await withTui(async (tui) => {
    const body = '<file relative_path="app/tui.js" from=1 to=3 lines=3>\nconst a = 1;\n</file>';
    const block = tui.logBlock({ header: '  [read_file Output] (intent: read it)', body });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(block.collapsed, true, 'multi-line tool output must start collapsed');
    assert.equal(block.chars, body.length);

    const content = visible(tui);
    assert.match(content, /\[read_file Output\] \(intent: read it\)/);
    assert.match(content, new RegExp(`${body.length} char response`));
    assert.equal(content.split('\n').filter((line) => line.includes('char response')).length, 1);
    // the payload itself is not painted while collapsed
    assert.doesNotMatch(content, /const a = 1;/);

    // a short single-line result stays readable inline (nothing to expand)
    const short = tui.logBlock({ header: '  [read_file Output]', body: 'tiny' });
    assert.equal(short.collapsed, false);
    assert.match(visible(tui), /tiny/);
  });
});

test('clicking a collapsed tool result expands it, clicking again collapses it', async () => {
  await withTui(async (tui) => {
    const body = 'line one\nline two\nline three';
    const block = tui.logBlock({ header: '  [run_bash Output]', body });
    await new Promise((resolve) => setImmediate(resolve));

    const range = tui.transcriptModel.rangeOf(block);
    assert.equal(range.end - range.start, 1, 'a collapsed block paints exactly one line');

    // expand: the payload appears, byte-for-byte, under the header
    assert.equal(clickLine(tui, range.start), block, 'the click lands on the block');
    assert.equal(block.collapsed, false);
    const expanded = visible(tui);
    assert.match(expanded, /line one/);
    assert.match(expanded, /line three/);
    assert.ok(expanded.includes(body.split('\n')[1]), 'the payload is stored verbatim');
    const openRange = tui.transcriptModel.rangeOf(block);
    assert.equal(openRange.end - openRange.start, 4);

    // collapse again: back to the single header line
    clickLine(tui, openRange.start);
    assert.equal(block.collapsed, true);
    const collapsed = visible(tui);
    assert.doesNotMatch(collapsed, /line one/);
    assert.match(collapsed, new RegExp(`${body.length} char response`));
  });
});

test('a click on a plain transcript line toggles nothing', async () => {
  await withTui(async (tui) => {
    tui.log('just prose, no block here');
    const block = tui.logBlock({ header: '  [read_file Output]', body: 'a\nb' });
    await new Promise((resolve) => setImmediate(resolve));

    // display line 0 is the prose: it belongs to no block
    assert.equal(clickLine(tui, 0), null);
    assert.equal(block.collapsed, true, 'the block must be untouched');
    // a click outside the widget is ignored too
    assert.equal(tui.clickTranscript({ x: 0, y: 0 }), null);
  });
});

test('the collapsed header keeps the size label right after the intent', async () => {
  await withTui(async (tui, { painted }) => {
    // main.js builds exactly this header for every tool result.
    const header = '\n  [read_file Output] (intent: why the file is read)';
    tui.logBlock({ header, body: 'x'.repeat(200) });
    await new Promise((resolve) => setImmediate(resolve));

    assert.match(
      visible(tui),
      /\[read_file Output\] \(intent: why the file is read\) — 200 char response/,
    );
    assert.match(plainText(painted()), /200 char response/);
    // the payload never reaches the frame while collapsed
    assert.doesNotMatch(plainText(painted()), /x{40}/);
  });
});

test('expanding a block keeps the transcript scroll position', async () => {
  await withTui(async (tui) => {
    const first = tui.logBlock({ header: '  [first Output]', body: 'a\nb\nc\nd' });
    for (let i = 0; i < 100; i += 1) tui.log(`line ${i}`);
    await new Promise((resolve) => setImmediate(resolve));

    tui.transcript.setScrollPerc(0);
    const before = tui.transcript.getScroll();
    assert.equal(before, 0, 'scrolled to the very top');

    tui.expandBlock(first.id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tui.transcript.getScroll(), before, 'the view must not jump to the end');
    assert.equal(first.collapsed, false);
  });
});

test('formatBlockHeader()/blockLines() describe the header a block paints', () => {
  const block = { collapsed: true, header: '  [tool Output]', chars: 12, bodyLines: ['a', 'b'] };
  assert.equal(formatBlockHeader(block), '▸   [tool Output] — 12 char response (click to expand)');
  assert.deepEqual(blockLines(block), ['▸   [tool Output] — 12 char response (click to expand)']);

  block.collapsed = false;
  assert.equal(formatBlockHeader(block), '▾   [tool Output] — 12 char response (click to collapse)');
  assert.deepEqual(blockLines(block), [
    '▾   [tool Output] — 12 char response (click to collapse)',
    'a',
    'b',
  ]);

  assert.equal(formatCharCount(undefined), '0 char response');
});

test('a block added through createTui() is reachable from the public surface', async () => {
  const tui = createTui({});
  assert.equal(tui, null, 'no TTY => no TUI');

  await withTui((tui_) => {
    const block = tui_.logBlock({ header: '  [tool Output]', body: 'a\nb' });
    assert.equal(tui_.blocks.length, 1);
    assert.equal(tui_.blocks[0], block);
    assert.equal(tui_.transcriptModel.findBlock(block.id), block);
    assert.equal(tui_.collapseBlock(block.id), block, 'already collapsed');
    assert.equal(tui_.expandBlock(block.id), block);
    assert.equal(block.collapsed, false);
    assert.equal(tui_.toggleBlock(block.id), block);
    assert.equal(block.collapsed, true);
    assert.equal(tui_.toggleBlock('missing'), null);
  });
});
