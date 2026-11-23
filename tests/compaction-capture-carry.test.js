import test from 'node:test';
import assert from 'node:assert/strict';

import { capturePointers, buildCaptureCarry, compactChunks } from '../utils/compaction.js';
import { COMPACTION_SUMMARY_PREFIX } from '../config/constants.js';

/**
 * Proof that a capture pointer survives a standard compaction
 * (docs/context/chunkpaction, docs/context/compaction).
 *
 * The twist this closes: a collapsed summary names `read_chunkpaction({ capture: N })`,
 * and the compaction summariser is a *model* — it paraphrases, so that line is exactly
 * the kind of detail it drops. The ids are therefore carried by code, like the user's
 * own words, so a compaction can never quietly orphan a capture.
 */

function big(text, repeat = 200) {
  return { role: 'user', content: `${text} ${'x'.repeat(repeat)}` };
}

// ---------------------------------------------------------------------------
// The pure half
// ---------------------------------------------------------------------------

test('capturePointers reads the ids a window names, and deduplicates them', () => {
  const chunks = [
    { role: 'system', content: 'plain' },
    { role: 'system', content: 'x', collapsed_capture: 2 },
    { role: 'system', content: 'y', collapsed_capture: 2 },
    { role: 'system', content: 'z', collapsed_capture: 5 },
  ];
  assert.deepEqual(capturePointers(chunks), [2, 5]);
});

test('capturePointers also reads an id out of the summary text', () => {
  // A chunk written before the structured field existed still names its capture in prose.
  const chunks = [
    { role: 'system', content: '[collapsed] "one" — solved.\nRaw chunks: read_chunkpaction({ capture: 3 }).' },
  ];
  assert.deepEqual(capturePointers(chunks), [3]);
});

test('capturePointers ignores anything that names no capture', () => {
  assert.deepEqual(capturePointers([]), []);
  assert.deepEqual(capturePointers([{ role: 'user', content: 'no pointer here' }]), []);
  assert.deepEqual(capturePointers([null, undefined, 'a string', 42]), []);
  assert.deepEqual(capturePointers(null), []);
  // A malformed field is not an id.
  assert.deepEqual(capturePointers([{ collapsed_capture: 'two' }, { collapsed_capture: -1 }]), []);
});

test('buildCaptureCarry names every capture, and nothing when there is none', () => {
  assert.equal(buildCaptureCarry([]), null, 'no captures, no line');
  assert.equal(buildCaptureCarry([0, -3, 'x']), null, 'junk is not a capture');

  const carry = buildCaptureCarry([1, 4]);
  assert.equal(carry.role, 'system', 'it is a chunk, so the model actually sees it');
  assert.deepEqual(carry.capture_carry, [1, 4]);
  assert.ok(carry.content.startsWith(COMPACTION_SUMMARY_PREFIX), 'it reads as a system note, like the summary');
  assert.ok(carry.content.includes('read_chunkpaction({ capture: 1 })'));
  assert.ok(carry.content.includes('read_chunkpaction({ capture: 4 })'));
});

// ---------------------------------------------------------------------------
// The carry through a real compaction
// ---------------------------------------------------------------------------

/** A window big enough that the older block holds the collapsed summary. */
function windowWithCollapsedSummary() {
  return [
    big('the first thing'),
    { role: 'system', content: `${COMPACTION_SUMMARY_PREFIX}\n[collapsed] "item one" — solved and collapsed (4 chunks). Raw chunks: read_chunkpaction({ capture: 2 }).`, collapsed: true, collapsed_capture: 2 },
    big('the second thing'),
    big('the third thing'),
    big('the fourth thing'),
    big('the fifth thing'),
    big('the sixth thing'),
    big('the seventh thing'),
    big('the eighth thing'),
  ];
}

test('a compaction carries the capture a collapsed summary named', async () => {
  const chunks = windowWithCollapsedSummary();
  const result = await compactChunks(chunks, {
    // A summariser that drops the pointer entirely — which is the whole reason the
    // carry is code rather than a request to the model.
    callModel: async () => 'A summary that mentions no capture at all.',
  });

  assert.equal(result.compacted, true);
  const carry = result.chunks.find((chunk) => (
    typeof chunk.content === 'string' && chunk.content.includes('read_chunkpaction')
  ));
  assert.ok(carry, `expected the capture line to survive, got:\n${result.chunks.map((c) => c.content).join('\n')}`);
  assert.ok(carry.content.includes('capture: 2'), 'and to name the id the summary named');
  assert.deepEqual(result.stats.capturedIds, [2]);
});

test('the carry is placed right after the summary, ahead of the kept tail', async () => {
  const chunks = windowWithCollapsedSummary();
  const result = await compactChunks(chunks, {
    callModel: async () => 'A summary that mentions no capture at all.',
  });

  assert.equal(result.chunks[0].compacted, true, 'the summary comes first');
  assert.ok(
    result.chunks[1].content.includes('read_chunkpaction'),
    'the carry rides immediately behind it, so it cannot be read as part of the tail',
  );
});

test('a compaction with no collapsed section adds no carry line', async () => {
  const chunks = [
    big('the first thing'), big('the second thing'), big('the third thing'),
    big('the fourth thing'), big('the fifth thing'), big('the sixth thing'),
    big('the seventh thing'), big('the eighth thing'),
  ];
  const result = await compactChunks(chunks, {
    callModel: async () => 'A summary of ordinary work.',
  });

  assert.equal(result.compacted, true);
  assert.ok(
    !result.chunks.some((chunk) => typeof chunk.content === 'string' && chunk.content.includes('read_chunkpaction')),
    'nothing to carry, nothing added',
  );
  assert.deepEqual(result.stats.capturedIds, []);
});

test('every capture named in the evicted block is carried, deduplicated', async () => {
  const chunks = [
    { role: 'system', content: 'a', collapsed_capture: 1 },
    { role: 'system', content: 'b', collapsed_capture: 1 },
    { role: 'system', content: 'c', collapsed_capture: 7 },
    big('filler one'), big('filler two'), big('filler three'),
    big('filler four'), big('filler five'), big('filler six'),
  ];
  const result = await compactChunks(chunks, {
    callModel: async () => 'A summary that mentions no capture at all.',
  });

  assert.deepEqual(result.stats.capturedIds, [1, 7]);
  const carry = result.chunks.find((chunk) => (
    typeof chunk.content === 'string' && chunk.content.includes('read_chunkpaction')
  ));
  assert.ok(carry.content.includes('capture: 1'));
  assert.ok(carry.content.includes('capture: 7'));
  assert.equal((carry.content.match(/read_chunkpaction/g) || []).length, 2, 'one call per id, not one per chunk');
});
