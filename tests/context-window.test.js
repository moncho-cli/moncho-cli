import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { ContextWindow } from '../app/context-window.js';
import { detectCompactionRequest } from '../app/conversation-manager.js';
import { execute as compactExecute, planCompaction } from '../tools/compact_context.js';
import { registerContextWindow, clearContextWindow } from '../utils/host.js';
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateRequestTokens,
  exceedsTokenBudget,
  formatTokenCount,
  formatUsage
} from '../utils/tokens.js';
import { SUMMARIZER_SYSTEM_PROMPT, buildSummaryPrompt, splitByTokenBudget, compactChunks, buildSummaryChunk, lastUserChunk } from '../utils/compaction.js';
import { COMPACTION_SUMMARY_PREFIX } from '../config/constants.js';

/**
 * The context machinery (docs/context/token-accounting, docs/context/compaction): the
 * token estimate, the 80/20 compaction, the live window and the compact_context tool.
 *
 * Split out of tests/harness-tools.test.js so each suite stays small and named after the
 * capability it proves (tests/README.md); that suite keeps the tool contract and the file
 * tools.
 */

function chunk(text, role = 'user') {
  return { role, content: text };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

test('token estimates are additive, rounded up and never negative', () => {
  assert.equal(estimateMessageTokens('abcd'), 1);
  assert.equal(estimateMessageTokens('abcde'), 2);
  assert.equal(estimateMessagesTokens(['abcd', 'abcd']), 2);
  assert.equal(estimateMessageTokens(null), 0);
  assert.ok(estimateMessageTokens({ role: 'user', content: 'x'.repeat(100) }) > 100 / 4);
  assert.ok(estimateRequestTokens([{ role: 'user', content: 'hi' }], [{ type: 'function' }]) > 0);
});

test('budget helpers and formatting', () => {
  const messages = [{ role: 'user', content: 'x'.repeat(400) }];
  assert.equal(exceedsTokenBudget(messages, 1000), false);
  assert.equal(exceedsTokenBudget(messages, 10), true);
  assert.equal(exceedsTokenBudget(messages, 0), false); // 0 = no limit
  assert.equal(formatTokenCount(1500), '1.50k');
  assert.match(formatUsage(messages, 1000), /tokens \(\d+%\)$/);
  assert.match(formatUsage(messages, 0), /\(no limit\)$/);
});

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

test('the older 80% / newest 20% split is driven by token mass', () => {
  const chunks = Array.from({ length: 5 }, (_, i) => chunk('x'.repeat(400), `m${i}`));
  const split = splitByTokenBudget(chunks);

  assert.equal(split.totalTokens, split.olderTokens + split.keptTokens);
  assert.ok(split.older.length > 0, 'something must be compacted');
  assert.ok(split.kept.length > 0, 'the newest chunks must survive');
  assert.ok(split.keptTokens >= split.totalTokens * 0.2 * 0.9, 'kept block should be ~20%');
  assert.ok(split.olderTokens >= split.keptTokens, 'the evicted block carries the bulk of the mass');
  assert.equal(split.older.at(-1), chunks[split.older.length - 1]);
  assert.equal(split.kept[0], chunks[split.older.length]);
});

test('a window of one chunk is never compacted away', () => {
  const split = splitByTokenBudget([chunk('only')]);
  assert.equal(split.older.length, 0);
  assert.equal(split.kept.length, 1);
});

test('compactChunks replaces the old block with one summary chunk and keeps the tail verbatim', async () => {
  const chunks = [
    chunk('AAAA'.repeat(100), 'assistant'),
    chunk('BBBB'.repeat(100), 'assistant'),
    chunk('recent-1'),
    chunk('recent-2')
  ];
  const { older, kept } = splitByTokenBudget(chunks);

  const result = await compactChunks(chunks, {
    callModel: async (messages) => {
      assert.equal(messages[0].role, 'system');
      assert.match(messages[1].content, /AAAA/); // the evicted text is what gets summarised
      assert.ok(!/recent-2/.test(messages[1].content), 'kept chunks must not be summarised');
      return 'SUMMARY: intent, done, pending';
    }
  });

  assert.equal(result.compacted, true);
  assert.equal(result.chunks[0].content, `${COMPACTION_SUMMARY_PREFIX}\nSUMMARY: intent, done, pending`);
  assert.equal(result.chunks[0].compacted, true);
  assert.equal(result.chunks[0].summarized_chunks, older.length);
  assert.deepEqual(result.chunks.slice(1), kept);
  assert.ok(result.stats.afterTokens < result.stats.totalTokens, 'compaction must shrink the window');
  assert.ok(result.summary.includes('SUMMARY'));
});

test('the last user message of the evicted block is carried verbatim', async () => {
  const ask = chunk('keep my words exactly', 'user');
  const chunks = [chunk('B'.repeat(400), 'assistant'), ask, chunk('the newest tail', 'assistant')];
  const { older, kept } = splitByTokenBudget(chunks);
  assert.equal(older.at(-1), ask, 'the ask must sit inside the block being summarised');
  assert.equal(kept.length, 1, 'the newest chunk survives verbatim');

  const result = await compactChunks(chunks, { callModel: async () => 'condensed history' });

  assert.equal(result.compacted, true);
  assert.equal(result.chunks[0].compacted, true, 'the summary still comes first');
  assert.equal(result.chunks[1], ask, 'the user chunk is re-inserted by reference, unaltered');
  assert.deepEqual(result.chunks[1], { role: 'user', content: 'keep my words exactly' });
  assert.deepEqual(result.chunks.slice(2), kept, 'the kept tail is untouched and still last');
  assert.equal(result.stats.carriedChunks, 1);
  assert.ok(result.stats.afterTokens < result.stats.totalTokens, 'the carry must not grow the window');
  // The carry is code, not a model answer: this summary never mentions the user's
  // words, and they are in the window all the same.
  assert.doesNotMatch(result.chunks[0].content, /keep my words exactly/);
  assert.equal(result.chunks[1].content, 'keep my words exactly');
});

test('a carry that would not shrink the window is dropped, and no user chunk means none', async () => {
  // The user's message *is* the bulk of the evicted block: re-inserting it would
  // hand back most of the tokens the compaction just reclaimed.
  const huge = chunk('A'.repeat(400), 'user');
  const heavy = await compactChunks(
    [huge, chunk('B'.repeat(400), 'assistant'), chunk('latest question')],
    { callModel: async () => 'condensed history' }
  );
  assert.equal(heavy.compacted, true);
  assert.equal(heavy.stats.carriedChunks, 0, 'a carry that would not shrink the window is skipped');
  assert.ok(!heavy.chunks.includes(huge), 'the oversized user chunk is evicted with the rest');

  // A block with no user chunk at all has nothing to carry.
  const assistantOnly = await compactChunks(
    [chunk('B'.repeat(400), 'assistant'), chunk('C'.repeat(400), 'assistant'), chunk('D'.repeat(400), 'assistant')],
    { callModel: async () => 'condensed history' }
  );
  assert.equal(assistantOnly.stats.carriedChunks, 0);
  assert.equal(lastUserChunk([]), null);
  assert.equal(lastUserChunk(null), null);
  assert.equal(lastUserChunk([chunk('one', 'assistant')]), null);
  assert.equal(lastUserChunk([chunk('one', 'user'), chunk('two', 'user')]).content, 'two');
});

test('compactChunks can report the split without calling the model', async () => {
  const chunks = [chunk('x'.repeat(400)), chunk('y'.repeat(400)), chunk('tail')];
  const result = await compactChunks(chunks, { dryRun: true });
  assert.equal(result.compacted, false);
  assert.equal(result.dryRun, true);
  assert.ok(result.stats.olderChunks > 0);
});

test('compactChunks refuses to squash an empty older block', async () => {
  const result = await compactChunks([chunk('only')], { callModel: async () => 'nope' });
  assert.equal(result.compacted, false);
  assert.equal(result.reason, 'nothing_to_compact');
});

test('an empty summary is rejected so the window is left unchanged', async () => {
  const chunks = [chunk('a'.repeat(400)), chunk('b'.repeat(400)), chunk('c')];
  await assert.rejects(
    () => compactChunks(chunks, { callModel: async () => '   ' }),
    /empty summary/
  );
});

test('buildSummaryChunk marks the compacted chunk', () => {
  const built = buildSummaryChunk(' body ', { summarizedChunks: 3 });
  assert.equal(built.compacted, true);
  assert.equal(built.summarized_chunks, 3);
  assert.ok(built.content.startsWith(COMPACTION_SUMMARY_PREFIX));
  assert.ok(built.content.endsWith('body'));
});

test('the compaction request is self-contained and the agent prompt says nothing about it', () => {
  // The summariser is asked with its own instruction plus the evicted chunks: the
  // agent system prompt deliberately stays out of it (`systemPrompt: false`), and
  // the agent prompt itself carries no compaction instructions at all.
  assert.match(SUMMARIZER_SYSTEM_PROMPT, /^You are the context-compaction component/);
  assert.match(SUMMARIZER_SYSTEM_PROMPT, /This message is the whole instruction/);
  assert.match(SUMMARIZER_SYSTEM_PROMPT, /keeps the user's own last message verbatim/);

  const prompt = buildSummaryPrompt([{ role: 'user', content: 'evicted text' }]);
  assert.match(prompt, /^Compaction request: summarise the 1 context chunk\(s\)/);
  assert.match(prompt, /nothing else is sent with this request/);
  assert.match(prompt, /evicted text/);

  const agentPrompt = fs.readFileSync(new URL('../prompt.md', import.meta.url), 'utf-8');
  assert.doesNotMatch(agentPrompt, /compact/i, 'the agent prompt must not instruct the agent about compaction');
  assert.doesNotMatch(agentPrompt, /CONTEXT_MAX_LENGTH/);
});

// ---------------------------------------------------------------------------
// ContextWindow wiring
// ---------------------------------------------------------------------------

test('ContextWindow reports usage and compacts in place when over budget', async () => {
  const window = new ContextWindow({ maxTokens: 200 });
  window.addMany([
    chunk('x'.repeat(2000), 'user'),
    chunk('y'.repeat(2000), 'assistant'),
    chunk('recent-1'),
    chunk('recent-2')
  ]);

  assert.equal(window.needsCompaction(), true);
  assert.match(window.usage(), /\/ 200 tokens/);
  assert.ok(window.estimatedTokens() > 200);

  const before = window.estimatedTokens();
  const report = await window.compact({ callModel: async () => 'condensed history' });

  assert.equal(report.compacted, true);
  assert.equal(window.chunks[0].compacted, true);
  assert.equal(window.chunks.at(-1).content, 'recent-2');
  assert.ok(window.estimatedTokens() < before, 'the window must shrink');
  assert.equal(window.stats().compactions, 1);
  assert.equal(window.stats().lastCompaction.reason, 'over-budget');
});

test('ContextWindow compaction is skipped while inside the budget', async () => {
  const window = new ContextWindow({ maxTokens: 100000 });
  window.add(chunk('small'));
  const report = await window.compact({ callModel: async () => { throw new Error('must not be called'); } });
  assert.equal(report.compacted, false);
  assert.equal(report.reason, 'within-budget');
});

test('a failed summariser call leaves the window untouched', async () => {
  const window = new ContextWindow({ maxTokens: 50 });
  window.addMany([chunk('x'.repeat(4000)), chunk('y'.repeat(4000)), chunk('tail')]);
  const before = window.chunks.slice();

  await assert.rejects(() => window.compact({ callModel: async () => { throw new Error('provider down'); } }), /provider down/);
  assert.deepEqual(window.chunks, before);
});

// ---------------------------------------------------------------------------
// compact_context tool
// ---------------------------------------------------------------------------

test('compact_context reports within-budget windows and requests compaction when over', async () => {
  const window = new ContextWindow({ maxTokens: 100 });
  registerContextWindow(window);

  const within = JSON.parse(await compactExecute({ intent: 'check window' }));
  assert.equal(within.status, 'skipped');
  assert.equal(within.code, 'WITHIN_BUDGET');

  window.addMany([chunk('z'.repeat(4000)), chunk('tail')]);
  const plan = planCompaction(window);
  assert.equal(plan.required, true);

  const requested = JSON.parse(await compactExecute({ intent: 'shrink window' }));
  assert.equal(requested.status, 'requested');
  assert.equal(requested.code, 'COMPACTION_REQUESTED');
  assert.equal(requested.defer, false, 'dryRun defaults to true, so the host loop is not deferred');
  assert.equal(detectCompactionRequest(JSON.stringify(requested)), false);

  const deferred = JSON.parse(await compactExecute({ intent: 'shrink window', dryRun: false }));
  assert.equal(deferred.defer, true);
  assert.equal(detectCompactionRequest(JSON.stringify(deferred)), true);

  clearContextWindow();
  const orphan = JSON.parse(await compactExecute({ intent: 'no window' }));
  assert.equal(orphan.code, 'NO_CONTEXT_WINDOW');
});
