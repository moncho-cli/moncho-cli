import test from 'node:test';
import assert from 'node:assert/strict';

import { runTurn } from '../app/turn-runner.js';
import { ContextWindow } from '../app/context-window.js';

/**
 * A message queued **while a turn runs** is injected mid-turn (task-backlog item 48).
 *
 * `tests/turn-runner.test.js` proves the turn's own flow; this file proves the one thing
 * the injection adds to it: a `user` chunk that lands at the **top of the per-call loop**,
 * which is the only boundary where it cannot split an assistant `tool_calls` message from
 * its `tool` results. The drain rule itself is the queue's own and is proven in
 * `tests/message-queue.test.js`; here the queue is a stub, so every case is about *where*
 * the chunk lands and what it does to the turn.
 */

const toolCall = (name = 'read_file', content = null) => ({
  message: {
    content,
    tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: '{"intent":"probe"}' } }],
  },
});

/**
 * A session with everything `runTurn()` touches, plus the injection seam.
 *
 * `queued` is the pending-message queue as a list: each call to `takeInjectedPrompt()`
 * hands over the whole list once (the batch rule) and then reports nothing waiting.
 * `handleToolCalls` stores the assistant message and one `tool` result per call, so the
 * *order* the injected chunk lands in is observable rather than assumed.
 */
function createSession(answers, { queued = [], overrides = {} } = {}) {
  const calls = [];
  const notices = [];
  const echoes = [];
  const chunksChanged = [];
  let pending = [...queued];

  const session = {
    contextWindow: new ContextWindow({ maxTokens: 100000, tools: () => [] }),
    onProse: (role, text) => echoes.push({ role, text }),
    getTools: () => [],
    getAbortSignal: () => 'the-signal',
    log: () => {},
    notifyContextChange: () => {},
    notifyChunksChanged: (reason) => chunksChanged.push(reason),
    notifyRetry: () => {},
    notifyNotice: (kind, text, options = {}) => notices.push({ kind, text, ...options }),
    beginModelCall: () => [],
    formatFailure: (error) => `Provider call failed: ${error.message}`,
    recordUsage: () => {},
    resetPulse: () => {},
    maybeCompact: async () => ({ compacted: false }),
    // The seam under test: the host's own drain, read at the top of each pass.
    //
    // The message is released only **after the first call has been sent**, which is the
    // real sequence: a queue drained by the host loop between turns is already empty
    // when a turn begins, so anything it holds at the top of a later pass is by
    // definition a message typed *while this turn was running* — the case under test.
    takeInjectedPrompt: () => {
      if (calls.length < 1 || !pending.length) return '';
      const batch = pending;
      pending = [];
      return batch.join('\n\n');
    },
    callModel: async (messages) => {
      calls.push({ messages });
      const next = answers.shift();
      if (!next) throw new Error('the turn asked for more answers than the stub holds');
      return next;
    },
    // The batch honours a per-batch gate override exactly as the manager's own batch
    // does (`docs/agent/approach-gate`), so a refusal is a real `tool` chunk and the
    // re-armed rule is observable rather than assumed.
    handleToolCalls: async (toolCalls, _signal, options = {}) => {
      const gate = typeof options.gate === 'function' ? options.gate : null;
      session.contextWindow.add({
        role: 'assistant',
        content: options.content ?? null,
        tool_calls: toolCalls,
      });
      for (const call of toolCalls) {
        const refusal = gate
          ? gate({ id: call.id, name: call.function.name, args: {}, rawArgs: '{}', intent: 'probe' })
          : null;
        session.contextWindow.add({
          role: 'tool',
          content: refusal
            ? JSON.stringify({ status: 'error', code: refusal.code, reason: refusal.reason })
            : `${call.function.name} result`,
        });
      }
      return false;
    },
    handleFinalResponse: async (content) => {
      session.contextWindow.add({ role: 'assistant', content });
    },
    ...overrides,
  };
  return { session, calls, notices, echoes, chunksChanged };
}

test('a message queued mid-turn is injected before the next call, not after the turn', async () => {
  const { session, calls } = createSession(
    [toolCall(), { message: { content: 'done' } }],
    { queued: ['please also check the config'] },
  );

  assert.deepEqual(await runTurn(session, 'start'), { ended: 'reply' });

  // The injected text is an ordinary `user` chunk, so the model sees it as a prompt.
  const injected = session.contextWindow.chunks.find(
    (chunk) => chunk.role === 'user' && chunk.content === 'please also check the config',
  );
  assert.ok(injected, 'the queued message landed in the window');

  // ... and it landed *after* the tool batch of the first call, not before it: the
  // request the second call carries holds it behind the assistant calls and results.
  assert.equal(calls.length, 2, 'the injection did not add a provider call of its own');
  const second = calls[1].messages.map((message) => message.content);
  const at = second.indexOf('please also check the config');
  assert.ok(at > 0, 'the injected message rides the request the next call sends');
  assert.equal(
    second.indexOf('read_file result') < at,
    true,
    'it lands after the tool results, never between an assistant call and its result',
  );
});

test('the injection never splits an assistant tool_calls message from its tool results', async () => {
  const { session } = createSession(
    [toolCall(), { message: { content: 'done' } }],
    { queued: ['steer'] },
  );

  await runTurn(session, 'start');

  // The window's own order is the contract: every `tool` chunk is immediately preceded
  // by another `tool` chunk or by the assistant message that asked for it. A `user`
  // chunk anywhere in that run is exactly the split this boundary exists to prevent.
  const chunks = session.contextWindow.chunks;

  // The check is not vacuous: the steer really did land mid-window, behind the first
  // call's results. Without this, the loop below would hold just as well on a turn that
  // injected nothing at all.
  const injectedAt = chunks.findIndex((chunk) => chunk.content === 'steer');
  assert.ok(injectedAt > 0, 'the steer landed behind the turn prompt');
  assert.equal(chunks[injectedAt - 1].role, 'tool', 'it followed the first call\'s result');

  chunks.forEach((chunk, index) => {
    if (chunk.role !== 'tool') return;
    const before = chunks[index - 1];
    assert.ok(
      before && (before.role === 'tool' || before.role === 'assistant'),
      `a tool result at ${index} follows ${before?.role}, not the call it answers`,
    );
  });
});

test('the injected message is echoed to the transcript as the user side of the dialogue', async () => {
  const { session, echoes } = createSession(
    [toolCall(), { message: { content: 'done' } }],
    { queued: ['steer'] },
  );

  await runTurn(session, 'start');

  assert.deepEqual(
    echoes.map((entry) => entry.text),
    ['start', 'steer'],
    'the turn prompt and the injected steer are both echoed, in that order',
  );
  assert.equal(echoes.every((entry) => entry.role === 'user'), true);
});

test('injecting announces the conversation change, so the record is written mid-turn', async () => {
  const { session, chunksChanged } = createSession(
    [toolCall(), { message: { content: 'done' } }],
    { queued: ['steer'] },
  );

  await runTurn(session, 'start');

  // `user` opens the turn and `injected` is the mid-turn steer: the session record
  // learns of a change it would otherwise only see once the turn ended.
  assert.deepEqual(chunksChanged, ['user', 'injected']);
});

test('a queue that is empty, absent, or throws changes nothing about the turn', async () => {
  // 1. Nothing queued.
  const empty = createSession([toolCall(), { message: { content: 'done' } }]);
  assert.deepEqual(await runTurn(empty.session, 'start'), { ended: 'reply' });
  assert.equal(empty.session.contextWindow.chunks.filter((c) => c.role === 'user').length, 1);

  // 2. No seam at all: every stub session written before this existed.
  const { session: bare } = createSession([{ message: { content: 'done' } }]);
  delete bare.takeInjectedPrompt;
  assert.deepEqual(await runTurn(bare, 'start'), { ended: 'reply' });

  // 3. A queue that throws is contained: a broken steer must never cost the user the turn.
  const { session: broken } = createSession([{ message: { content: 'done' } }], {
    overrides: { takeInjectedPrompt: () => { throw new Error('the queue exploded'); } },
  });
  assert.deepEqual(await runTurn(broken, 'start'), { ended: 'reply' });
});

test('a steer is a new message, so the model owes it a seed of its own', async () => {
  // The first batch carries prose (the seed) and so is allowed through. A bare batch after
  // the injection must be refused *again*: the steer asked for something new, and
  // `docs/agent/approach-gate` makes a new user message a new seed to write. Without the
  // re-arm, `addressed` would have stayed latched and the bare batch would have run.
  const { session, notices } = createSession(
    [
      toolCall('read_file', 'I will read the fixture first.'),
      toolCall('read_file'),
      { message: { content: 'done' } },
    ],
    { queued: ['now change direction'], overrides: { approachMaxRefusals: 2 } },
  );

  assert.deepEqual(await runTurn(session, 'start'), { ended: 'reply' });

  const required = notices.filter((notice) => notice.code === 'approach-required');
  assert.equal(required.length, 1, 'the post-injection batch was asked for a seed');
  // The refusal is a chunk, so the model reads what to answer in its own context.
  assert.ok(
    session.contextWindow.chunks.some(
      (chunk) => chunk.role === 'tool' && String(chunk.content).includes('TOOL_REFUSED_BEFORE_APPROACH'),
    ),
    'the refusal reached the context',
  );
});
