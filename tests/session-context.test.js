import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

/**
 * The conversation's own identity, handed to the model on every request
 * (task-backlog item 51: "the session path <--> conversation relation must be hard,
 * saved in memory, no need to guess").
 *
 * The model used to learn its folder only from an `update_task` reply, so before the
 * first tracking call it had nothing to go on and would grep the tree for the folder it
 * was already sitting in. `utils/session-context.js` renders one `system` message per
 * request with the resolved paths; this suite proves the wording, the seam, and the two
 * properties that make it safe: it is never a window chunk, and it is constant for the
 * whole session so the request prefix stays cache-stable.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-session-context-'));
process.chdir(root);
process.env.CONTEXT_MAX_LENGTH = '100000';

const requests = [];
let answers = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const request = JSON.parse(body);
    requests.push(request);
    const next = answers.shift() || { content: 'done' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: next }] }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/api/chat`;

const {
  SESSION_MARKER,
  formatSessionBlock,
  sessionBlockMessage,
} = await import('../utils/session-context.js');
const { registerSession, clearSession } = await import('../utils/host.js');
const { ConversationManager } = await import('../app/conversation-manager.js');
const { ContextWindow } = await import('../app/context-window.js');

const SESSION = {
  id: 'session-context-test',
  dir: 'agent/sessions',
  path: 'agent/sessions/session-context-test/context.json',
};

/** The agent requests of the stub server, in send order. */
const agentRequests = () => requests.filter(
  (request) => !request.messages.some((m) => /context-compaction component/.test(m.content || '')),
);

/** The session block carried by a request, or null. */
const blockOf = (request) => request.messages.find(
  (m) => m.role === 'system' && (m.content || '').startsWith(SESSION_MARKER),
) || null;

function createManager(options = {}) {
  return new ConversationManager(() => {}, () => [], () => null, { log: () => {}, ...options });
}

test('the block states the session id and every resolved path, and says not to guess', () => {
  const block = formatSessionBlock({
    id: 'abc',
    folder: 'agent/sessions/abc',
    task: 'agent/sessions/abc/task.md',
    plan: 'agent/sessions/abc/implementation_plan.md',
    record: 'agent/sessions/abc/context.json',
  });

  assert.ok(block.startsWith(SESSION_MARKER), 'the block is recognisable by its marker');
  assert.match(block, /session id is abc/);
  for (const file of ['task.md', 'implementation_plan.md', 'context.json']) {
    assert.ok(block.includes(`agent/sessions/abc/${file}`), `${file} arrives resolved`);
  }
  assert.match(block, /never grep or scan the tree/, 'it says what not to do');
  assert.match(block, /fixed for the whole conversation/, 'and that the folder does not move');
});

test('an incomplete session renders nothing, so no half-answer reaches the model', () => {
  assert.equal(formatSessionBlock({}), '');
  assert.equal(formatSessionBlock({ id: 'abc' }), '', 'a folder is required');
  assert.equal(
    formatSessionBlock({ id: 'abc', folder: 'agent/sessions/abc', task: 'x' }),
    '',
    'both tracking paths are required',
  );
});

test('without a registered session there is no block, so a bare call is unchanged', () => {
  clearSession();
  assert.equal(sessionBlockMessage(), null);
});

test('the block resolves the paths of the registered session', () => {
  registerSession({ ...SESSION });
  const message = sessionBlockMessage();

  assert.equal(message.role, 'system');
  assert.ok(message.content.includes('agent/sessions/session-context-test/task.md'));
  assert.ok(message.content.includes('agent/sessions/session-context-test/implementation_plan.md'));
  assert.ok(message.content.includes('agent/sessions/session-context-test/context.json'));
  clearSession();
});

test('the block rides every agent request, after the prompt and before the conversation', async () => {
  requests.length = 0;
  answers = [{ content: 'first reply' }];
  registerSession({ ...SESSION });

  const manager = createManager();
  await manager.processInput('where do I live?');

  const request = agentRequests().at(0);
  assert.equal(request.messages[0].role, 'system');
  assert.match(request.messages[0].content, /MONCHO-CLI/, 'the agent prompt stays first');
  assert.equal(request.messages[1].role, 'system', 'the block follows the prompt');
  assert.match(request.messages[1].content, /^\[session\]/);
  assert.equal(request.messages[2].role, 'user', 'the conversation follows the block');
  clearSession();
});

test('the block is never a window chunk, so the session record stays the conversation', async () => {
  requests.length = 0;
  answers = [{ content: 'first reply' }];
  registerSession({ ...SESSION });

  const manager = createManager();
  await manager.processInput('where do I live?');

  assert.ok(
    !manager.chunks.some((chunk) => (chunk.content || '').startsWith(SESSION_MARKER)),
    'the block is host data, not conversation',
  );
  clearSession();
});

test('the block stays byte-identical across a turn, so the request prefix stays cacheable', async () => {
  requests.length = 0;
  answers = [
    { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{}' } }] },
    { content: 'done' },
  ];
  registerSession({ ...SESSION });

  const manager = createManager();
  await manager.processInput('where do I live?');

  const agent = agentRequests();
  assert.ok(agent.length >= 2, 'the tool loop makes more than one agent call');
  const first = blockOf(agent[0]);
  for (const request of agent.slice(1)) {
    const block = blockOf(request);
    assert.equal(block.content, first.content, 'the block never changes between calls');
    assert.deepEqual(
      request.messages.slice(0, 2),
      agent[0].messages.slice(0, 2),
      'so the prefix a provider caches is repeated verbatim',
    );
  }
  clearSession();
});

test('a window that needs compaction still sends the block on the agent call', async () => {
  requests.length = 0;
  answers = [{ content: 'summarised' }, { content: 'done' }];
  registerSession({ ...SESSION });

  const window = new ContextWindow({ maxTokens: 1, tools: () => [] });
  const manager = createManager({ contextWindow: window });
  await manager.processInput('where do I live?');

  const summariser = requests.filter((r) => !agentRequests().includes(r));
  for (const request of summariser) {
    assert.equal(blockOf(request), null, 'an internal call never carries the conversation identity');
  }
  const agent = agentRequests();
  assert.ok(agent.length >= 1, 'the agent call still runs');
  assert.ok(blockOf(agent.at(-1)), 'and it carries the block');
  clearSession();
});

test.after(() => server.close());
