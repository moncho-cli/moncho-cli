import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildUnaddressedChunk,
  buildUnaddressedPrompt,
  compactChunks,
  previousSummaryChunk,
  splitByTokenBudget,
} from '../utils/compaction.js';
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_UNADDRESSED_PREFIX } from '../config/constants.js';

/**
 * Proof that a *repeated* compaction carries what the previous summary left unaddressed
 * (docs/context/compaction, backlog: "when a compaction runs and there is a previous
 * compaction block, make an additional request for the model to return what has not been
 * addressed from that compaction").
 *
 * The failure this closes is specific and quiet: the first compaction's summary lists
 * things pending, the next compaction summarises *that summary*, and its pending list —
 * the one thing that was not work that happened — is what the model drops first. So the
 * audit is one extra request, and its answer rides ahead of the newest summary.
 */

/** A chunk large enough that the window really splits. */
function big(text, repeat = 200) {
  return { role: 'user', content: `${text} ${'x'.repeat(repeat)}` };
}

/** A window whose evicted block holds one earlier compaction summary. */
function windowWithPreviousSummary() {
  return [
    big('the original ask'),
    {
      role: 'system',
      content: `${COMPACTION_SUMMARY_PREFIX}\n1. Intent: port the tracking pair.\n3. Pending: wire the /ref flag.`,
      compacted: true,
      summarized_chunks: 6,
    },
    big('the second thing'),
    big('the third thing'),
    big('the fourth thing'),
    big('the fifth thing'),
    big('the sixth thing'),
    big('the seventh thing'),
    big('the eighth thing'),
  ];
}

// ---------------------------------------------------------------------------
// The pure half
// ---------------------------------------------------------------------------

test('previousSummaryChunk finds the newest summary, and a collapsed section is not one', () => {
  const older = { role: 'system', content: `${COMPACTION_SUMMARY_PREFIX}\nold`, compacted: true };
  const newer = { role: 'system', content: `${COMPACTION_SUMMARY_PREFIX}\nnew`, compacted: true };
  assert.equal(previousSummaryChunk([older, big('a'), newer]), newer, 'the newest one is the live statement');

  // A collapsed item's summary describes work that is *done*, so it is not audited.
  const collapsed = { role: 'system', content: `${COMPACTION_SUMMARY_PREFIX}\ncollapsed`, collapsed: true };
  assert.equal(previousSummaryChunk([collapsed, big('a')]), null);

  // A chunk restored from a session written before the field existed still counts.
  assert.equal(previousSummaryChunk([{ role: 'system', content: `${COMPACTION_SUMMARY_PREFIX}\nrendered` }]).content.includes('rendered'), true);

  assert.equal(previousSummaryChunk([]), null);
  assert.equal(previousSummaryChunk(null), null);
  assert.equal(previousSummaryChunk([big('a'), big('b')]), null);
});

test('buildUnaddressedChunk keeps a real answer and refuses "nothing pending"', () => {
  const chunk = buildUnaddressedChunk('- wire the /ref flag\n- verify the picker');
  assert.equal(chunk.role, 'system', 'it is a chunk, so the model actually sees it');
  assert.equal(chunk.unaddressed, true);
  assert.ok(chunk.content.startsWith(COMPACTION_UNADDRESSED_PREFIX));
  assert.ok(chunk.content.includes('wire the /ref flag'));

  // Nothing pending must cost no tokens at all, so the answer is asked for as NONE.
  assert.equal(buildUnaddressedChunk('NONE'), null);
  assert.equal(buildUnaddressedChunk('  none  '), null);
  assert.equal(buildUnaddressedChunk(''), null);
  assert.equal(buildUnaddressedChunk('   '), null);
  assert.equal(buildUnaddressedChunk(null), null);
});

test('the audit request quotes the earlier summary once and carries the record beside it', () => {
  const summary = { role: 'system', content: `${COMPACTION_SUMMARY_PREFIX}\nUNIQUE-SUMMARY-TEXT`, compacted: true };
  const prompt = buildUnaddressedPrompt(summary, [summary, big('LATER-RECORD')]);
  assert.equal(prompt.match(/UNIQUE-SUMMARY-TEXT/g).length, 1, 'the summary is not repeated in the payload');
  assert.ok(prompt.includes('LATER-RECORD'), 'the record that answers the audit is included');
});

// ---------------------------------------------------------------------------
// The four-part window
// ---------------------------------------------------------------------------

test('a repeated compaction carries what the previous summary left unaddressed', async () => {
  const chunks = windowWithPreviousSummary();
  const { older } = splitByTokenBudget(chunks);
  assert.ok(older.some((c) => c.compacted === true), 'the earlier summary must sit in the evicted block');

  const purposes = [];
  const result = await compactChunks(chunks, {
    callModel: async (messages, ctx) => {
      purposes.push(ctx.purpose);
      if (ctx.purpose === 'context-compaction-unaddressed') {
        assert.match(messages[0].content, /left unaddressed/, 'the audit has its own instruction');
        assert.match(messages[1].content, /wire the \/ref flag/, 'and it is shown the earlier pending list');
        return '- wire the /ref flag\n- verify the picker';
      }
      return 'a fresh summary of the work';
    },
  });

  assert.equal(result.compacted, true);
  assert.deepEqual(purposes, ['context-compaction', 'context-compaction-unaddressed'], 'one extra request, after the summary');
  assert.equal(result.stats.previousSummary, true);
  assert.equal(result.stats.unaddressedAsked, true);
  assert.equal(result.stats.unaddressedChunks, 1);

  // The window reads: unaddressed, summary, carried user message, kept tail.
  assert.equal(result.chunks[0].unaddressed, true, 'the audit comes first');
  assert.ok(result.chunks[0].content.includes('wire the /ref flag'));
  assert.equal(result.chunks[1].compacted, true, 'the newest summary second');
  const tail = result.chunks.at(-1);
  assert.equal(tail.role, 'user', 'the kept tail is still last and untouched');
  assert.ok(result.stats.afterTokens < result.stats.totalTokens, 'the audit must not stop the window shrinking');
});

test('a first compaction asks nothing extra and keeps the shape it had', async () => {
  const chunks = [
    big('the first thing'), big('the second thing'), big('the third thing'),
    big('the fourth thing'), big('the fifth thing'), big('the sixth thing'),
    big('the seventh thing'), big('the eighth thing'),
  ];
  let calls = 0;
  const result = await compactChunks(chunks, {
    callModel: async () => {
      calls += 1;
      return 'a summary of ordinary work';
    },
  });

  assert.equal(calls, 1, 'no previous summary means no second model call');
  assert.equal(result.stats.previousSummary, false);
  assert.equal(result.stats.unaddressedChunks, 0);
  assert.equal(result.chunks[0].compacted, true, 'the summary is still first');
  assert.ok(!result.chunks.some((chunk) => chunk.unaddressed === true));
});

test('an answer of NONE falls back to the shape it had, and says it was asked', async () => {
  const result = await compactChunks(windowWithPreviousSummary(), {
    callModel: async (_messages, ctx) => (
      ctx.purpose === 'context-compaction-unaddressed' ? 'NONE' : 'a fresh summary'
    ),
  });

  assert.equal(result.compacted, true);
  assert.equal(result.stats.previousSummary, true, 'a previous summary was there');
  assert.equal(result.stats.unaddressedAsked, true, 'and the audit really ran');
  assert.equal(result.stats.unaddressedChunks, 0, 'nothing pending means no chunk');
  assert.equal(result.chunks[0].compacted, true, 'so the newest summary is first again');
  assert.ok(!result.chunks.some((chunk) => chunk.unaddressed === true));
});

test('a failed audit never costs the compaction', async () => {
  const result = await compactChunks(windowWithPreviousSummary(), {
    callModel: async (_messages, ctx) => {
      if (ctx.purpose === 'context-compaction-unaddressed') throw new Error('the audit call failed');
      return 'a fresh summary';
    },
  });

  assert.equal(result.compacted, true, 'the window is still compacted');
  assert.equal(result.stats.unaddressedAsked, false, 'the failure is reported, not hidden');
  assert.equal(result.stats.unaddressedChunks, 0);
  assert.equal(result.chunks[0].compacted, true);
});

test('the kept tail and the carried user message still survive a repeated compaction', async () => {
  const ask = { role: 'user', content: 'keep these words exactly' };
  const chunks = [
    { role: 'system', content: `${COMPACTION_SUMMARY_PREFIX}\npending: wire /ref`, compacted: true },
    big('filler one'), big('filler two'), big('filler three'), big('filler four'), big('filler five'),
    ask,
    { role: 'assistant', content: 'the newest tail' },
  ];
  const result = await compactChunks(chunks, {
    callModel: async (_messages, ctx) => (
      ctx.purpose === 'context-compaction-unaddressed' ? '- wire /ref' : 'a fresh summary'
    ),
  });

  assert.equal(result.chunks[0].unaddressed, true, 'audit first');
  assert.equal(result.chunks[1].compacted, true, 'summary second');
  const carriedIndex = result.chunks.indexOf(ask);
  assert.ok(carriedIndex > 1, 'the user message is still re-inserted by reference');
  assert.equal(result.chunks.at(-1).content, 'the newest tail', 'and the kept tail is still last');
  assert.equal(result.stats.carriedChunks, 1);
});