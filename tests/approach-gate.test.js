import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROACH_REFUSAL_CODE,
  APPROACH_REQUIRED_NOTICE,
  APPROACH_SKIPPED_NOTICE,
  approachRefusal,
  formatApproachRefusalLine,
} from '../app/approach-gate.js';
import { isRefusalLine } from '../app/refusal-line.js';
import { classifyLine } from '../app/theme.js';
import { runTurn } from '../app/turn-runner.js';
import { ContextWindow } from '../app/context-window.js';
import { handleToolBatch } from '../app/tool-batch.js';

/**
 * The approach rule, *enforced* (docs/agent/approach-gate): the stated approach seeds the
 * turn.
 *
 * The shape being proven is one user message → one statement of intent → as much work as
 * the task needs. The loop reads each assistant message it receives and latches the seed:
 * while the turn has none, a message whose calls carry no prose is refused whole (no tool
 * runs, every call still gets its one result chunk) and the model is asked again; once the
 * seed is written, every later batch of the turn is ordinary. The policy behind it — what
 * counts as prose, the refusal, the bound, and the wording the model reads — is a value
 * and is proven without a provider in `tests/approach-seed.test.js`.
 */

/** One OpenAI-shaped call. */
const call = (name = 'read_file', id = 'call_1') => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify({ intent: 'probe' }) },
});

/** A stub session over a real window, with the seam runTurn() documents. */
function createSession(answers, overrides = {}) {
  const notices = [];
  const lines = [];
  const batches = [];
  const session = {
    contextWindow: new ContextWindow({ maxTokens: 100000, tools: () => [] }),
    approachMaxRefusals: 2,
    getTools: () => [],
    getAbortSignal: () => null,
    log: (line) => lines.push(String(line)),
    notifyContextChange: () => {},
    notifyChunksChanged: () => {},
    notifyRetry: () => {},
    notifyNotice: (kind, text, options = {}) => notices.push({ kind, text, ...options }),
    beginModelCall: () => [],
    recordUsage: () => {},
    resetPulse: () => {},
    maybeCompact: async () => ({ compacted: false }),
    callModel: async () => {
      const next = answers.shift();
      if (!next) throw new Error('the turn asked for more answers than the stub holds');
      return next;
    },
    handleToolCalls: async (toolCalls, _signal, options = {}) => {
      batches.push({ toolCalls, options });
      return false;
    },
    handleFinalResponse: async (content) => {
      session.contextWindow.add({ role: 'assistant', content });
    },
    ...overrides,
  };
  return { session, notices, lines, batches };
}

test('a message whose calls carry no prose is refused whole, and the model is asked again', async () => {
  const { session, notices, batches } = createSession([
    // The model names a tool without a word: this must not run.
    { message: { content: null, tool_calls: [call('read_file', 'a'), call('grep', 'b')] } },
    // Told what to answer, it states its approach and calls the tool in the same message.
    { message: { content: 'I will read the fixture, then grep for the symbol.', tool_calls: [call('read_file', 'c')] } },
    { message: { content: 'Done.' } },
  ]);

  const result = await runTurn(session, 'inspect the fixture');

  assert.deepEqual(result, { ended: 'reply' });
  assert.equal(batches.length, 2, 'the refused batch plus the announced one');

  // The refusal is the whole batch: the gate override answers for every call.
  const refused = batches[0].options;
  assert.equal(refused.content, null, 'nothing was announced, so the chunk carries no prose');
  assert.equal(refused.gate().code, APPROACH_REFUSAL_CODE);
  assert.equal(refused.gate().mode, null);

  // The announced batch carries the prose *and* runs under the session's own gate.
  assert.equal(batches[1].options.content, 'I will read the fixture, then grep for the symbol.');
  assert.equal(batches[1].options.gate, undefined, 'an announced batch keeps the normal gate');

  // The model is told, once, what to answer instead.
  const asked = notices.filter((notice) => notice.code === 'approach-required');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].text, APPROACH_REQUIRED_NOTICE);
});

test('the seed is written once, and the batches after it grow from it unannounced', async () => {
  // The shape of a turn: one user message, one statement of intent, then as much work as
  // the task needs. Only the message that *writes* the seed carries prose; the rest are
  // bare calls, and they are the operations that prose promised.
  const { session, notices, batches } = createSession([
    { message: { content: 'I will read the module, then its tests, then run them.', tool_calls: [call('read_file', 'a')] } },
    { message: { content: null, tool_calls: [call('read_file', 'b')] } },
    { message: { content: null, tool_calls: [call('run_bash', 'c')] } },
    { message: { content: null, tool_calls: [call('read_file', 'd')] } },
    { message: { content: 'Read it, ran the suite; it passes.' } },
  ]);

  const result = await runTurn(session, 'check the module');

  assert.deepEqual(result, { ended: 'reply' }, 'the closing reply ends the turn, as prose should');
  assert.equal(batches.length, 4, 'the seeded batch plus three bare ones');
  assert.equal(batches[0].options.content, 'I will read the module, then its tests, then run them.');
  for (const batch of batches.slice(1)) {
    assert.equal(batch.options.gate, undefined, 'a batch after the seed keeps the normal gate');
    assert.equal(batch.options.content, null, 'and needs no prose of its own');
  }

  // Nothing was ever asked again: the turn had its seed, so the rule had nothing to say.
  assert.deepEqual(notices, [], 'the rule is about the seed, not about every tool call');
});

test('the bound is spent and the batch runs, with the skip said once', async () => {
  // A model that never speaks: every answer is a bare call.
  const stubborn = () => ({ message: { content: null, tool_calls: [call()] } });
  const { session, notices, batches } = createSession(
    [stubborn(), stubborn(), stubborn(), stubborn(), { message: { content: 'Done.' } }],
    { approachMaxRefusals: 2 },
  );

  await runTurn(session, 'go');

  // Two refusals, then every later batch is allowed through: the turn cannot be starved.
  assert.equal(batches.length, 4);
  assert.equal(batches[0].options.gate().code, APPROACH_REFUSAL_CODE);
  assert.equal(batches[1].options.gate().code, APPROACH_REFUSAL_CODE);
  assert.equal(batches[2].options.gate, undefined, 'the batch past the bound is not refused');
  assert.equal(batches[3].options.gate, undefined);

  // The re-ask is said per refusal; the skip is *news* about the bound, so once.
  assert.equal(notices.filter((notice) => notice.code === 'approach-required').length, 2);
  const skips = notices.filter((notice) => notice.code === 'approach-skipped');
  assert.equal(skips.length, 1, 'the skip is said once, not once per batch');
  assert.equal(skips[0].text, APPROACH_SKIPPED_NOTICE);
});

test('a session that declares no bound is not policed at all', async () => {
  const { session, notices, batches } = createSession(
    [{ message: { content: null, tool_calls: [call()] } }, { message: { content: 'Done.' } }],
    { approachMaxRefusals: 0 },
  );

  await runTurn(session, 'go');

  assert.equal(batches.length, 1, 'the first batch runs straight away');
  assert.equal(batches[0].options.gate, undefined);
  assert.deepEqual(notices, [], 'no notice is raised where no rule applies');
});

test('the refused batch still owes the provider one result per call', async () => {
  const window = { chunks: [], add(chunk) { this.chunks.push(chunk); } };
  const lines = [];
  let invoked = 0;

  const report = await handleToolBatch({
    toolCalls: [call('read_file', 'a'), call('grep', 'b')],
    window,
    log: (line) => lines.push(String(line)),
    toolFunctions: {
      read_file: async () => { invoked += 1; return 'contents'; },
      grep: async () => { invoked += 1; return 'matches'; },
    },
    gate: () => approachRefusal(),
  });

  assert.equal(invoked, 0, 'nothing runs before the turn is addressed');
  assert.equal(report.guarded, 2);

  const results = window.chunks.filter((chunk) => chunk.role === 'tool');
  assert.deepEqual(results.map((chunk) => chunk.tool_call_id), ['a', 'b'], 'one result per call id');
  for (const chunk of results) {
    assert.match(chunk.content, new RegExp(APPROACH_REFUSAL_CODE), 'the refusal reaches the model');
  }

  // The reader gets the same news, as the palette's own refusal rows.
  const rows = lines.filter((line) => isRefusalLine(line));
  assert.equal(rows.length, 2);
  assert.equal(rows[0], formatApproachRefusalLine({ name: 'read_file' }));
  assert.equal(classifyLine(rows[0]), 'refusal');
});

test('the stated prose rides the assistant chunk next to the calls', async () => {
  const window = { chunks: [], add(chunk) { this.chunks.push(chunk); } };
  const lines = [];
  const prose = 'I will read the fixture and then grep for the symbol.';

  await handleToolBatch({
    toolCalls: [call('read_file')],
    window,
    content: prose,
    log: (line) => lines.push(String(line)),
    toolFunctions: { read_file: async () => 'contents' },
  });

  const assistant = window.chunks.find((chunk) => chunk.role === 'assistant');
  assert.equal(assistant.content, prose, 'the approach stays in the model context');
  assert.equal(assistant.tool_calls.length, 1, 'and the calls travel on the same chunk');

  // The reader sees it before the call it introduces, so the transcript reads as
  // "here is what I am about to do", then the doing.
  const proseAt = lines.indexOf(prose);
  const callAt = lines.findIndex((line) => line.includes('Calling read_file'));
  assert.ok(proseAt !== -1 && callAt !== -1);
  assert.ok(proseAt < callAt, 'the stated approach is printed before the call');
});

test('a batch with no prose keeps the chunk shape every session already holds', async () => {
  const window = { chunks: [], add(chunk) { this.chunks.push(chunk); } };

  await handleToolBatch({
    toolCalls: [call('read_file')],
    window,
    toolFunctions: { read_file: async () => 'contents' },
  });

  assert.equal(window.chunks[0].content, null, 'an unannounced batch is stored exactly as before');
});

test('the live manager enforces the rule end to end, and the refusal lands in its window', async () => {
  // The real ConversationManager: the option the host wires (main.js) is the only
  // thing that turns the rule on, so this is the case that proves the shipped path.
  const { ConversationManager } = await import('../app/conversation-manager.js');
  const invoked = [];
  const answers = [
    { message: { content: null, tool_calls: [call('read_file', 'a')] } },
    { message: { content: 'Reading the fixture to see what it holds.', tool_calls: [call('read_file', 'b')] } },
    { message: { content: 'Done.' } },
  ];

  const manager = new ConversationManager(
    { read_file: async () => { invoked.push('read_file'); return 'contents'; } },
    () => [],
    () => null,
    { log: () => {}, approachMaxRefusals: 2, callModel: async () => answers.shift() },
  );

  await manager.processInput('read the fixture');

  assert.deepEqual(invoked, ['read_file'], 'the tool ran only after the turn was addressed');

  // The refused call still owes the provider one result, and that result is in the window.
  const refused = manager.chunks.find((chunk) => chunk.role === 'tool' && chunk.tool_call_id === 'a');
  assert.ok(refused, 'the refusal is part of the context');
  assert.match(refused.content, new RegExp(APPROACH_REFUSAL_CODE));

  // The announced approach rides the assistant chunk next to the calls.
  const announced = manager.chunks.find((chunk) => chunk.role === 'assistant' && chunk.tool_calls?.[0]?.id === 'b');
  assert.equal(announced.content, 'Reading the fixture to see what it holds.');
});

