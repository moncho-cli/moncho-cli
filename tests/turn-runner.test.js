import test from 'node:test';
import assert from 'node:assert/strict';

import { runTurn, isAbortFailure } from '../app/turn-runner.js';
import { ContextWindow } from '../app/context-window.js';

/**
 * The one-turn loop, driven by a *stub session* instead of a provider.
 *
 * app/turn-runner.js holds the control flow of a turn (ask, run the tool batch,
 * end on the first tool-free reply) while app/conversation-manager.js holds the
 * state. This file proves the flow by implementing the documented seam as a plain
 * object, so every case here is about the loop and nothing about the network.
 */

/** A session with everything runTurn() touches, over a real ContextWindow. */
function createSession(answers, overrides = {}) {
  const calls = [];
  const notices = [];
  const lines = [];
  const session = {
    contextWindow: new ContextWindow({ maxTokens: 100000, tools: () => [] }),
    onUserMessage: null,
    getTools: () => [{ type: 'function', function: { name: 'read_file' } }],
    getAbortSignal: () => 'the-signal',
    log: (line) => lines.push(String(line)),
    notifyContextChange: () => {},
    notifyRetry: (report) => notices.push({ kind: 'warn', code: 'retry', report }),
    notifyNotice: (kind, text, options = {}) => notices.push({ kind, text, ...options }),
    beginModelCall: () => [{ role: 'system', content: 'PULSE' }],
    formatFailure: (error) => `Provider call failed: ${error.message}`,
    recordUsage: () => {},
    resetPulse: (reason) => calls.push({ reset: reason }),
    maybeCompact: async () => ({ compacted: false }),
    callModel: async (messages, tools, signal, options) => {
      calls.push({ messages, tools, signal, hasOnRetry: typeof options.onRetry === 'function' });
      const next = answers.shift();
      if (!next) throw new Error('the turn asked for more answers than the stub holds');
      return next;
    },
    handleToolCalls: async (toolCalls) => toolCalls.some((c) => c.function.name === 'defer'),
    handleFinalResponse: async (content) => {
      session.contextWindow.add({ role: 'assistant', content });
      calls.push({ reply: content });
    },
    ...overrides,
  };
  return { session, calls, notices, lines };
}

const toolCall = (name = 'read_file') => ({
  message: {
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: '{"intent":"probe"}' } }],
  },
});

test('runTurn() asks, runs the tool batch, and ends on the first tool-free reply', async () => {
  const { session, calls } = createSession([toolCall(), { message: { content: 'all done' } }]);

  const result = await runTurn(session, 'read the fixture');

  assert.deepEqual(result, { ended: 'reply' });
  assert.equal(session.contextWindow.chunks[0].content, 'read the fixture', 'the prompt is the first chunk');
  assert.equal(session.contextWindow.chunks.at(-1).content, 'all done', 'the reply closes the window');
  // The request carries the prelude (the pulse line) and the live tool definitions.
  const [first] = calls;
  assert.equal(first.messages[0].content, 'PULSE');
  assert.equal(first.tools[0].function.name, 'read_file');
  assert.equal(first.signal, 'the-signal', 'the turn passes the active task signal');
  assert.equal(first.hasOnRetry, true, 'the retry hook is wired');
  assert.equal(calls.at(-1).reply, 'all done');
});

test('runTurn() counts every call and compacts when a tool defers it', async () => {
  const resets = [];
  const { session } = createSession(
    [toolCall('defer'), { message: { content: 'done' } }],
    {
      resetPulse: (reason) => resets.push(reason),
      maybeCompact: async (_signal, options = {}) => (
        options.force ? { compacted: true } : { compacted: false }
      ),
    },
  );

  await runTurn(session, 'go');

  assert.deepEqual(resets, ['compaction'], 'a forced compaction restarts the pulse');
});

test('an abort ends the turn quietly, with no failure line and no notice', async () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const { session, notices, lines } = createSession([], {
    callModel: async () => { throw abort; },
  });

  const result = await runTurn(session, 'abort me');

  assert.deepEqual(result, { ended: 'abort' });
  assert.deepEqual(notices, [], 'an abort is not a failure to report');
  assert.ok(lines.some((l) => l.includes('aborted')), 'the transcript says why the task stopped');
  assert.ok(!lines.some((l) => l.includes('Error calling')), 'an abort is never an error');
});

test('a provider failure ends the turn as a notice plus a transcript line', async () => {
  const failure = new Error('connect ECONNREFUSED');
  const { session, notices, lines } = createSession([], {
    callModel: async () => { throw failure; },
  });

  const result = await runTurn(session, 'go');

  assert.deepEqual(result, { ended: 'error' });
  assert.equal(notices[0].code, 'provider-failure');
  assert.equal(notices[0].kind, 'error');
  assert.match(lines.join('\n'), /Error calling Ollama: connect ECONNREFUSED/);
});

test('isAbortFailure() recognises both shapes an abort arrives in', () => {
  assert.equal(isAbortFailure(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  assert.equal(isAbortFailure(new Error('The operation was aborted')), true);
  assert.equal(isAbortFailure(new Error('HTTP error! status: 502')), false);
  assert.equal(isAbortFailure(null), false);
});