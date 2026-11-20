import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConversationManager } from '../app/conversation-manager.js';
import { ContextWindow } from '../app/context-window.js';
import { MAX_PARALLEL_TOOL_CALLS, TOO_MANY_TOOL_CALLS } from '../config/constants.js';
import { loadTools } from '../utils/tool-loader.js';
import { parseToolChunk } from '../app/tool-call-format.js';
import { formatRefusalLine, isRefusalLine } from '../app/refusal-line.js';
import {
  planToolBatch,
  dispatchToolCalls,
  handleToolBatch,
  formatBatchRefusal,
  formatBatchLine,
} from '../app/tool-batch.js';

/**
 * Running one tool batch (task-backlog: "tool calling should allow the model to
 * ask with an array of tools, up to 5 simultaneous calls").
 *
 * The grammar of the envelope that carries each result is proven in
 * `tests/tool-multicall.test.js`; these cases prove the *dispatch*: the cap, the
 * simultaneous run, the call order, the error and abort paths, and the chunks the
 * loop stores in the context window.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-tool-batch-'));
process.chdir(root);
fs.writeFileSync('fixture.txt', 'fixture content\n', 'utf-8');

/** One OpenAI-shaped tool call, the way a provider answers. */
const call = (id, name, args) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

/** A tool map that records when each call starts, to prove they overlap. */
function recordingTools() {
  const started = [];
  const active = new Set();
  let peak = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const track = (name, ms, value) => async () => {
    started.push(name);
    active.add(name);
    peak = Math.max(peak, active.size);
    await sleep(ms);
    active.delete(name);
    return value;
  };
  return {
    started,
    get peak() { return peak; },
    tools: {
      slow: track('slow', 60, 'slow done'),
      fast: track('fast', 5, 'fast done'),
      boom: async () => { throw new Error('kaboom'); },
    },
  };
}

test('planToolBatch() accepts the first five calls and refuses the rest in order', () => {
  const calls = Array.from({ length: 7 }, (_, i) => call(`c${i}`, 'read_file', { path: `f${i}.txt`, intent: `read f${i}` }));
  const plan = planToolBatch(calls);

  assert.equal(MAX_PARALLEL_TOOL_CALLS, 5, 'the cap the backlog asks for');
  assert.equal(plan.max, 5);
  assert.equal(plan.total, 7);
  assert.deepEqual(plan.accepted.map((e) => e.call.id), ['c0', 'c1', 'c2', 'c3', 'c4'], 'accepted by position');
  assert.deepEqual(plan.refused.map((e) => e.call.id), ['c5', 'c6'], 'the remainder is refused, never dropped');
  assert.equal(plan.simultaneous, true);
  assert.equal(planToolBatch([calls[0]]).simultaneous, false, 'a lone call is not a batch');
  assert.equal(planToolBatch(null).total, 0, 'no calls is an empty batch, not an error');
  assert.equal(planToolBatch(calls, { max: 2 }).accepted.length, 2, 'the cap is injectable');
  assert.equal(planToolBatch(calls, { max: 0 }).max, 5, 'a nonsense cap falls back to the constant');
  assert.match(formatBatchLine({ accepted: 5, refused: 2 }), /batch: 5 call\(s\) at once \(max 5\) · 2 refused/);
});

test('a batch is dispatched simultaneously and its outcomes keep the call order', async () => {
  const recorder = recordingTools();
  const plan = planToolBatch([
    call('a', 'slow', { intent: 'slow one' }),
    call('b', 'fast', { intent: 'fast one' }),
  ]);

  const outcomes = await dispatchToolCalls(plan.accepted, recorder.tools);

  assert.ok(recorder.peak >= 2, `the calls must overlap, saw ${recorder.peak} at a time`);
  assert.deepEqual(recorder.started, ['slow', 'fast'], 'the fast call starts before the slow one finishes');
  assert.deepEqual(outcomes.map((o) => o.id), ['a', 'b'], 'call order, not completion order');
  assert.equal(outcomes[0].result, 'slow done');
  assert.equal(outcomes[0].succeeded, true);
  assert.equal(outcomes[0].signature, 'slow(intent=string(8))');
});

test('a throwing tool and an unknown tool become error outcomes, never failures', async () => {
  const recorder = recordingTools();
  const outcomes = await dispatchToolCalls(
    planToolBatch([
      call('a', 'boom', { intent: 'fail' }),
      call('b', 'nosuchtool', { intent: 'nope' }),
      call('c', 'fast', { intent: 'fine' }),
    ]).accepted,
    recorder.tools,
  );

  assert.deepEqual(outcomes.map((o) => o.isError), [true, true, false]);
  assert.match(outcomes[0].result, /^Error executing boom: kaboom$/);
  assert.match(outcomes[1].result, /^Error executing nosuchtool: unknown tool\.$/);
  assert.equal(outcomes[2].result, 'fast done', 'one bad call does not poison the batch');
});

test('an aborted task skips the calls instead of starting them', async () => {
  const recorder = recordingTools();
  let ran = 0;
  const outcomes = await dispatchToolCalls(
    planToolBatch([call('a', 'slow', { intent: 'slow' }), call('b', 'count', { intent: 'count' })]).accepted,
    { ...recorder.tools, count: async () => { ran += 1; return 'counted'; } },
    { signal: { aborted: true } },
  );

  assert.equal(ran, 0, 'no work is started for a cancelled task');
  assert.equal(recorder.started.length, 0);
  assert.deepEqual(outcomes.map((o) => o.isError), [true, true]);
  assert.match(outcomes[0].result, /cancelled before the call started/);
});

test('the loop stores one enveloped chunk per call, in call order', async () => {
  const recorder = recordingTools();
  const chunks = [];
  const window = { add: (chunk) => { chunks.push(chunk); return chunk; } };

  const report = await handleToolBatch({
    toolCalls: [call('a', 'slow', { intent: 'first' }), call('b', 'fast', { intent: 'second' })],
    window,
    toolFunctions: recorder.tools,
    log: () => {},
  });

  const [assistant, ...tools] = chunks;
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.content, null);
  assert.deepEqual(assistant.tool_calls.map((c) => c.id), ['a', 'b'], 'one assistant chunk carries the whole batch');
  assert.equal(tools.length, 2, 'one chunk per call: the provider pairs ids');
  assert.deepEqual(tools.map((c) => c.tool_call_id), ['a', 'b']);
  assert.equal(report.executed, 2);
  assert.deepEqual(report.order, ['a', 'b']);

  const first = parseToolChunk(tools[0].content);
  assert.equal(first.signature, 'slow(intent=string(5))');
  assert.equal(first.body, 'slow done');
  assert.equal(first.calls, 2);
  assert.ok(tools[0].content.startsWith('intent: first\n<tool-multicall result calls=2>'));

  // every call of the batch is announced before any of them runs
  const lines = [];
  await handleToolBatch({
    toolCalls: [call('a', 'fast', { intent: 'one' }), call('b', 'fast', { intent: 'two' })],
    toolFunctions: recorder.tools,
    log: (line) => lines.push(String(line)),
  });
  const announced = lines.findIndex((line) => line.includes('Calling fast'));
  const secondCall = lines.findIndex((line) => line.includes('intent: two'));
  assert.ok(announced >= 0 && secondCall > announced, `both calls are announced up front: ${JSON.stringify(lines)}`);
});

test('a call beyond the cap is answered with a structured TOO_MANY_TOOL_CALLS refusal', async () => {
  const recorder = recordingTools();
  const chunks = [];
  const window = { add: (chunk) => { chunks.push(chunk); return chunk; } };
  const calls = [
    call('a', 'fast', { intent: 'first' }),
    ...[0, 1, 2, 3, 4].map((i) => call(`x${i}`, 'fast', { intent: `extra ${i}` })),
  ];

  const report = await handleToolBatch({ toolCalls: calls, window, toolFunctions: recorder.tools, log: () => {} });

  assert.equal(report.executed, 5);
  assert.equal(report.refused, 1);
  assert.deepEqual(report.order, ['a', 'x0', 'x1', 'x2', 'x3', 'x4'], 'every id is answered, in order');
  assert.equal(chunks[0].tool_calls.length, 6, 'the assistant chunk still carries every call');

  const refused = parseToolChunk(chunks.find((c) => c.tool_call_id === 'x4').content);
  assert.equal(refused.isError, true);
  assert.equal(refused.signature, 'fast(intent=string(7))', 'the refusal names the call it dropped');
  const payload = JSON.parse(refused.body);
  assert.equal(payload.status, 'error');
  assert.equal(payload.code, TOO_MANY_TOOL_CALLS);
  assert.equal(payload.max, 5);
  assert.match(payload.guidance, /at most 5 tools at a time/);
  assert.match(formatBatchRefusal({ name: 'x', requested: 6 }), /"max": 5/);
});

test('handleToolCalls() batches the calls of one assistant message', async () => {
  const { toolFunctions } = await loadTools(() => {});
  const window = new ContextWindow({ maxTokens: 100000 });
  const manager = new ConversationManager(toolFunctions, () => [], () => null, {
    log: () => {},
    contextWindow: window,
  });

  const wantsCompaction = await manager.handleToolCalls([
    call('a', 'read_file', { path: 'fixture.txt', intent: 'read the fixture once' }),
    call('b', 'read_file', { path: 'fixture.txt', intent: 'read the fixture twice' }),
  ], null);

  assert.equal(wantsCompaction, false);
  assert.equal(manager.lastBatch.executed, 2);
  assert.equal(manager.lastBatch.simultaneous, true);
  assert.equal(manager.chunks.length, 3, 'the assistant chunk plus two tool chunks');

  for (const chunk of manager.chunks.filter((c) => c.role === 'tool')) {
    const parsed = parseToolChunk(chunk.content);
    assert.match(parsed.signature, /^read_file\(path=string\(11\), intent=string\(/);
    assert.match(parsed.body, /fixture content/, 'the real tool output travels in the envelope');
    assert.equal(parsed.calls, 2);
  }
});

test('a call beyond the cap is refused in one row, worded like its chunk', async () => {
  const recorder = recordingTools();
  const chunks = [];
  const window = { add: (chunk) => { chunks.push(chunk); return chunk; } };
  const lines = [];
  const calls = [
    ...[0, 1, 2, 3, 4].map((i) => call(`c${i}`, 'fast', { intent: `call ${i}` })),
    call('c5', 'fast', { intent: 'one too many' }),
  ];

  const report = await handleToolBatch({
    toolCalls: calls,
    window,
    toolFunctions: recorder.tools,
    log: (line) => lines.push(String(line)),
  });

  assert.equal(report.refused, 1);
  const payload = JSON.parse(parseToolChunk(chunks.at(-1).content).body);
  assert.equal(payload.code, TOO_MANY_TOOL_CALLS);

  // One row for the reader, carrying the very reason the model was handed: the two
  // are built from the same string, so a rewrite of one is a rewrite of both.
  const row = lines.find((line) => isRefusalLine(line));
  assert.ok(row, `the refused call is shown in the transcript: ${JSON.stringify(lines)}`);
  assert.equal(row, formatRefusalLine({ name: 'fast', reason: payload.message }));
  assert.match(row, /only 5 run in a batch/);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
