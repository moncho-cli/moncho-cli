import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_ITEM,
  COLLAPSED_ITEM_PREFIX,
  normalizeItems,
  alignItems,
  findItemRuns,
  cutsToolBatch,
  summarizeRun,
  buildCollapsedChunk,
  collapseCompletedItems,
} from '../utils/item-collapse.js';

/**
 * Proof for the item attribution and the deterministic collapse
 * (docs/context/item-collapse, task-backlog item 75).
 *
 * The entry's own caveat is the design: the collapse "only works when we are 100%
 * sure that chunk corresponds to an item". So the cases below are as much about what
 * is *refused* — an unattributed chunk, a half-cut tool batch, a run that would not
 * shrink — as about what is collapsed.
 */

/** A chunk with real content: a collapse only pays for itself on a run that has some. */
const long = (text) => ({ role: 'user', content: `${text} ${'x'.repeat(400)}` });
const user = (text) => ({ role: 'user', content: text });
const assistant = (text) => ({ role: 'assistant', content: text });
const call = (name, id = 'c1') => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
});
const result = (id = 'c1') => ({ role: 'tool', tool_call_id: id, content: 'ok' });

// ---------------------------------------------------------------------------
// The attribution array
// ---------------------------------------------------------------------------

test('an attribution list is forced to the chunk count, junk becoming NO_ITEM', () => {
  assert.deepEqual(normalizeItems(['a', 'b'], 2), ['a', 'b']);
  assert.deepEqual(normalizeItems(['a'], 3), ['a', NO_ITEM, NO_ITEM], 'a short list is padded');
  assert.deepEqual(normalizeItems(['a', 'b', 'c'], 1), ['a'], 'a long list is trimmed');
  assert.deepEqual(normalizeItems(['', '  ', 7, null], 4), [NO_ITEM, NO_ITEM, NO_ITEM, NO_ITEM]);
  assert.deepEqual(normalizeItems(null, 2), [NO_ITEM, NO_ITEM]);
});

test('attributions follow their chunks by identity across a rewrite', () => {
  const kept = user('kept');
  const carried = user('carried');
  const gone = user('gone');
  const summary = assistant('summary');

  const next = alignItems({
    previousChunks: [gone, carried, kept],
    previousItems: ['item one', 'item two', 'item two'],
    nextChunks: [summary, carried, kept],
    fallback: NO_ITEM,
  });

  assert.deepEqual(
    next,
    [NO_ITEM, 'item two', 'item two'],
    'a surviving chunk keeps its item, and a new one belongs to nothing',
  );
});

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

test('a run is contiguous chunks of one item, and a gap breaks it', () => {
  const chunks = [user('a'), assistant('b'), user('c'), user('d')];
  const runs = findItemRuns(chunks, ['one', 'one', NO_ITEM, 'two']);

  assert.deepEqual(
    runs.map((run) => ({ item: run.item, start: run.start, end: run.end })),
    [{ item: 'one', start: 0, end: 2 }, { item: 'two', start: 3, end: 4 }],
    'the unattributed chunk in the middle ends the first run',
  );
  assert.equal(runs[0].chunks.length, 2);
});

test('a window with no attribution has no runs at all', () => {
  assert.deepEqual(findItemRuns([user('a'), user('b')], [NO_ITEM, NO_ITEM]), []);
  assert.deepEqual(findItemRuns([], []), []);
});

// ---------------------------------------------------------------------------
// The tool-batch guard
// ---------------------------------------------------------------------------

test('a run that would cut a tool batch in half is not collapsed', () => {
  const chunks = [user('ask'), call('read_file'), result(), user('next')];

  // The run starts at the result: its call would be summarised away, which the
  // provider refuses with a 400 — and keeps refusing, because the history is carried.
  assert.equal(cutsToolBatch(chunks, 2, 3), true, 'a run starting with a result is unsafe');
  // The run ends at the call: its results would be left outside it.
  assert.equal(cutsToolBatch(chunks, 0, 2), true, 'a run ending with a call is unsafe');
  // A whole batch inside the run is safe: the call and its results travel together.
  assert.equal(cutsToolBatch(chunks, 1, 3), false, 'a whole batch inside the run is fine');
  // A run touching neither edge of the window is judged on its own contents.
  assert.equal(cutsToolBatch(chunks, 0, 1), false, 'a plain chunk run is safe');
  // A run that reaches the end of the window is safe even if it ends with a call:
  // there are no results outside it to be orphaned.
  assert.equal(cutsToolBatch(chunks, 1, 4), false, 'a run reaching the window end is safe');
});

// ---------------------------------------------------------------------------
// The collapse
// ---------------------------------------------------------------------------

test('a completed item collapses into one deterministic chunk', () => {
  const chunks = [long('do it'), call('read_file'), result(), long('done'), user('after')];
  const items = ['item one', 'item one', 'item one', 'item one', NO_ITEM];

  const first = collapseCompletedItems(chunks, items, { completed: ['item one'] });
  const second = collapseCompletedItems(chunks, items, { completed: ['item one'] });

  assert.equal(first.collapsed.length, 1);
  assert.equal(first.chunks.length, 2, 'four chunks became one, plus the untouched tail');
  assert.equal(first.chunks[0].collapsed, true);
  assert.equal(first.chunks[0].collapsed_item, 'item one');
  assert.equal(first.chunks[0].collapsed_chunks, 4);
  assert.ok(first.chunks[0].content.startsWith(COLLAPSED_ITEM_PREFIX));
  assert.ok(first.chunks[0].content.includes('read_file'), 'the tools used are named');
  assert.equal(first.chunks[1], chunks[4], 'the chunk outside the run is untouched');
  assert.deepEqual(first.items, [NO_ITEM, NO_ITEM], 'a collapsed section belongs to no item');
  assert.deepEqual(second.chunks, first.chunks, 'the same window collapses the same way');
});

test('an item that is not completed is never collapsed', () => {
  const chunks = [long('a'), long('b')];
  const items = ['item one', 'item one'];

  const open = collapseCompletedItems(chunks, items, { completed: [] });
  assert.deepEqual(open.collapsed, []);
  assert.deepEqual(open.chunks, chunks, 'the chunks are the very same objects, untouched');

  const other = collapseCompletedItems(chunks, items, { completed: ['item two'] });
  assert.deepEqual(other.collapsed, [], 'only the item that is done is a candidate');
});

test('a chunk with no attribution is never collapsed', () => {
  const chunks = [long('a'), long('b')];
  const result = collapseCompletedItems(chunks, [NO_ITEM, NO_ITEM], { completed: ['item one'] });
  assert.deepEqual(result.collapsed, []);
  assert.deepEqual(result.chunks, chunks);
});

test('a run too short to be worth it, or that would not shrink, is left alone', () => {
  const single = [long('a')];
  assert.deepEqual(
    collapseCompletedItems(single, ['item one'], { completed: ['item one'] }).collapsed,
    [],
    'one chunk replaced by a summary of it is not a saving',
  );

  // An injected estimator that says the summary is not smaller: the run must stay.
  const chunks = [long('a'), long('b')];
  const noSaving = collapseCompletedItems(chunks, ['item one', 'item one'], {
    completed: ['item one'],
    estimate: () => 1000,
  });
  assert.deepEqual(noSaving.collapsed, []);
  assert.deepEqual(noSaving.chunks, chunks, 'a collapse that would grow the window is refused');
});

test('the whole window is never collapsed away', () => {
  const chunks = [long('a'), long('b')];
  const result = collapseCompletedItems(chunks, ['item one', 'item one'], { completed: ['item one'] });
  assert.deepEqual(result.collapsed, [], 'something has to remain to send');
  assert.deepEqual(result.chunks, chunks);
});

test('a run that would cut a tool batch is skipped, and the rest still collapses', () => {
  // Run one ends at a call whose results sit outside it, so it is unsafe; run two is a
  // plain pair of chunks and collapses.
  const chunks = [long('a'), call('read_file'), result(), long('b'), long('c')];
  const items = ['item one', 'item one', NO_ITEM, 'item two', 'item two'];

  const collapsedResult = collapseCompletedItems(chunks, items, { completed: ['item one', 'item two'] });
  assert.deepEqual(collapsedResult.collapsed.map((entry) => entry.item), ['item two']);
  assert.equal(collapsedResult.chunks.length, 4, 'the unsafe pair stays verbatim, the safe run collapsed');
  assert.deepEqual(collapsedResult.chunks.slice(0, 3), chunks.slice(0, 3));
  assert.equal(collapsedResult.chunks[3].collapsed, true);
});

test('summarizeRun names the item, the size and the tools, and is stable', () => {
  const run = { item: 'wire it', chunks: [call('run_bash'), call('read_file'), result()] };
  const text = summarizeRun(run);

  assert.ok(text.startsWith(`${COLLAPSED_ITEM_PREFIX} "wire it"`));
  assert.ok(text.includes('3 chunks'));
  assert.ok(text.includes('2 tool calls'));
  assert.ok(text.includes('read_file, run_bash'), 'the tools are named in a stable order');
  assert.equal(summarizeRun(run), text, 'the same run always produces the same text');
});

test('buildCollapsedChunk marks the chunk as collapsed and names its item', () => {
  const chunk = buildCollapsedChunk('summary text', { item: 'x', collapsedChunks: 3 });
  assert.equal(chunk.role, 'system');
  assert.equal(chunk.content, 'summary text');
  assert.equal(chunk.collapsed, true);
  assert.equal(chunk.collapsed_item, 'x');
  assert.equal(chunk.collapsed_chunks, 3);
});
