import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';

/**
 * The model-call pulse in the loop (task-backlog: "keep in the context an
 * incremental pulse on each model call, create a hard limit configurable defaulting
 * to 30, and instruct via prompt.md to honor this value. reset it to 0 after marking
 * an item as completed or running compaction").
 *
 * The *pure* counter and its wording are proved in tests/call-pulse.test.js; this
 * file proves the wiring: the counter ticks once per agent call, the (currently
 * disabled) line never reaches the request and never becomes a window chunk, the
 * summariser call does not tick the counter, and a completed item or a compaction
 * puts it back to 0.
 *
 * The env is set before the dynamic imports because config/constants.js reads it at
 * module load; Node gives this test file its own process.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-call-pulse-loop-'));
process.chdir(root);

process.env.OPENAI_BASE_URL = 'http://127.0.0.1:0/v1/chat/completions';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MODEL = 'stub-model';
process.env.CONTEXT_MAX_LENGTH = '100000';

const requests = [];
/** How many tool-answering calls the stub still owes before it settles. */
let toolAnswers = 1;
let callId = 0;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const parsed = JSON.parse(body);
    requests.push(parsed);

    const isSummarizer = parsed.messages.some(
      (message) => message.role === 'system' && /context-compaction component/.test(message.content || '')
    );
    let message;
    if (isSummarizer) {
      message = { role: 'assistant', content: 'SUMMARY: intent, work done, pending.' };
    } else if (toolAnswers > 0) {
      toolAnswers -= 1;
      callId += 1;
      message = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `call_${callId}`,
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'fixture.txt', intent: 'read the fixture' }),
          },
        }],
      };
    } else {
      message = { role: 'assistant', content: 'all done' };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1/chat/completions`;

const { loadTools } = await import('../utils/tool-loader.js');
const { ConversationManager } = await import('../app/conversation-manager.js');
const { ContextWindow } = await import('../app/context-window.js');
const { PULSE_MARKER } = await import('../utils/task-pulse.js');
const { getTaskPulse, resetTaskPulse, clearTaskPulse } = await import('../utils/host.js');

fs.writeFileSync('fixture.txt', 'fixture content\n', 'utf-8');
const { tools, toolFunctions } = await loadTools(() => {});

const isAgentCall = (request) =>
  !request.messages.some((m) => /context-compaction component/.test(m.content || ''));

/** The pulse lines carried by the agent requests, in send order. */
const pulseLines = () => requests
  .filter(isAgentCall)
  .map((request) => request.messages.find((m) => (m.content || '').startsWith(PULSE_MARKER))?.content || null);

function createManager(options = {}) {
  return new ConversationManager(toolFunctions, () => tools, () => null, { log: () => {}, ...options });
}

test('no agent request carries a pulse line or an empty system message while it is disabled', async () => {
  requests.length = 0;
  toolAnswers = 1;

  const manager = createManager();
  await manager.processInput('read the fixture');

  const lines = pulseLines();
  assert.equal(lines.length, 2, 'the turn makes two agent calls');
  assert.deepEqual(lines, [null, null], 'the line is disabled, so none is carried');

  // The request is the agent prompt followed by the conversation: a disabled line
  // must not leave an empty `system` message behind, which would still be a role
  // marker the provider bills and the prompt cache hashes.
  const first = requests.at(0);
  assert.equal(first.messages[0].role, 'system');
  assert.match(first.messages[0].content, /MONCHO-CLI/, 'the agent prompt stays first');
  assert.equal(first.messages[1].role, 'user', 'the conversation follows the agent prompt');
  assert.ok(
    !first.messages.some((m) => (m.content ?? '') === ''),
    'no empty message is sent'
  );

  // The counter still runs even though its line is not sent, and it is never a
  // window chunk: the session stays the conversation itself.
  assert.ok(
    !manager.chunks.some((chunk) => (chunk.content || '').startsWith(PULSE_MARKER)),
    'the pulse must not be a window chunk'
  );
  assert.equal(manager.pulseStats().count, 2);
});

test('the summariser call is not an agent call and does not carry or tick the pulse', async () => {
  requests.length = 0;
  toolAnswers = 1;

  const window = new ContextWindow({ maxTokens: 30, tools: () => tools });
  const manager = createManager({ contextWindow: window });
  await manager.processInput('read the fixture');

  const summarizerRequests = requests.filter((request) => !isAgentCall(request));
  assert.ok(summarizerRequests.length >= 1, 'the turn compacted, so the summariser ran');
  for (const request of summarizerRequests) {
    assert.ok(
      !request.messages.some((m) => (m.content || '').startsWith(PULSE_MARKER)),
      'an internal call must not carry the pulse'
    );
  }

  // A compaction also starts the budget again: it is one of the two named resets.
  const stats = manager.pulseStats();
  assert.ok(stats.resets >= 1, 'the compaction reset the pulse');
  assert.equal(stats.resetReason, 'compaction');
});

test('the pulse counts calls and warns once past the hard limit without refusing them', async () => {
  requests.length = 0;
  toolAnswers = 3;
  const notices = [];

  const manager = createManager({
    pulseLimit: 2,
    onNotice: (kind, text, options) => notices.push({ kind, text, ...options }),
  });
  await manager.processInput('read the fixture over and over');

  const lines = pulseLines();
  assert.equal(lines.length, 4);
  assert.deepEqual(lines, [null, null, null, null], 'the line is disabled, so none is carried');

  const warnings = notices.filter((notice) => notice.code === 'pulse-limit');
  assert.equal(warnings.length, 1, 'the crossing is announced exactly once per stretch');
  assert.equal(warnings[0].kind, 'warn');
  assert.match(warnings[0].text, /passed its hard limit/);
  assert.equal(manager.chunks.at(-1).content, 'all done', 'the turn still completed');
});

test('the request prefix never changes between agent calls, so the prompt cache can be hit', async () => {
  requests.length = 0;
  toolAnswers = 3;

  const manager = createManager();
  await manager.processInput('read the fixture repeatedly');

  const agent = requests.filter(isAgentCall);
  assert.equal(agent.length, 4, 'the tool loop makes four agent calls');

  for (let i = 1; i < agent.length; i += 1) {
    const previous = agent[i - 1].messages;
    const current = agent[i].messages;
    assert.ok(current.length > previous.length, 'a later call only appends to the conversation');
    assert.deepEqual(
      current.slice(0, previous.length),
      previous,
      `call ${i + 1} must repeat call ${i} byte-for-byte as its prefix`
    );
  }
});

test('completing a task.md item resets the live pulse through the host registry', async () => {
  requests.length = 0;
  toolAnswers = 0;

  fs.writeFileSync('task.md', [
    '# Task',
    '',
    'status: in progress',
    '',
    '- [ ] wire the pulse',
    '- [ ] document it',
    '',
  ].join('\n'), 'utf-8');
  fs.writeFileSync('implementation_plan.md', '# Plan\n\n- [ ] a step\n', 'utf-8');

  const manager = createManager();
  await manager.processInput('read the fixture');
  assert.equal(manager.pulseStats().count, 1);
  assert.equal(getTaskPulse(), manager.pulse, 'the manager registers the live pulse');

  const result = JSON.parse(await toolFunctions.update_task(JSON.stringify({
    action: 'complete',
    item: 'wire the pulse',
    intent: 'the first item is verified',
  })));

  assert.equal(result.status, 'success');
  assert.equal(result.pulseReset, true, 'the tool reports the reset it performed');
  assert.equal(manager.pulseStats().count, 0, 'the live counter went back to 0');
  assert.equal(manager.pulseStats().resetReason, 'item-completed');

  // `status` is a metadata edit: it must not refill the budget.
  manager.pulse.tick();
  const status = JSON.parse(await toolFunctions.update_task(JSON.stringify({
    action: 'status',
    status: 'in progress',
    intent: 'record the status',
  })));
  assert.equal(status.pulseReset, false);
  assert.equal(manager.pulseStats().count, 1, 'a status edit does not reset the pulse');
});

test('resetTaskPulse reaches the live pulse and refuses an empty registry', () => {
  assert.equal(resetTaskPulse('manual'), true, 'the manager above registered a live pulse');

  // `update_task` may well be called before any conversation started: nothing to
  // reset has to be a refusal, never a throw.
  clearTaskPulse();
  assert.equal(getTaskPulse(), null);
  assert.equal(resetTaskPulse('manual'), false);
});

test.after(() => server.close());
