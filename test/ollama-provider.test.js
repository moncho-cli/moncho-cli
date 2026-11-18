import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * Provider-layer verification against a local stub server.
 *
 * Node runs each test file in its own process, so the provider environment can be
 * set here before the modules (which read it at import time) are loaded.
 *
 * What this proves for the harness work:
 *  - the agent system prompt is still injected for normal calls (prompt.md), and
 *  - `systemPrompt:false` really omits it, which is what lets the context
 *    summariser behind task.md item 8 run as a neutral summariser instead of
 *    answering as Moncho.
 */

const requests = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }
    requests.push(parsed);

    // OpenAI-compatible shape, which normalizeResponse must understand.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'stub reply' } }]
    }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1/chat/completions`;
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MODEL = 'stub-model';

const { callOllama } = await import('../api/ollama.js');
const { describeModel, detectProvider } = await import('../config/constants.js');

test('detectProvider maps common base URLs (task.md item 5)', () => {
  assert.equal(detectProvider('https://openrouter.ai/api/v1/chat/completions'), 'openrouter');
  assert.equal(detectProvider('https://api.openai.com/v1/chat/completions'), 'openai');
  assert.equal(detectProvider('http://host.containers.internal:11434/api/chat'), 'ollama');
  assert.equal(detectProvider('https://generativelanguage.googleapis.com/v1beta'), 'gemini');
  assert.equal(detectProvider('not a url'), 'unknown');
});

test('describeModel reports the configured provider and model', () => {
  const info = describeModel();
  assert.equal(info.model, 'stub-model');
  assert.equal(info.provider, '127.0.0.1');
  assert.ok(info.label.includes('stub-model'));
});

test('a default call injects the agent system prompt and normalises the response', async () => {
  const data = await callOllama([{ role: 'user', content: 'hello' }], [], false, null);
  assert.equal(data.message.content, 'stub reply');

  const sent = requests.at(-1);
  assert.equal(sent.model, 'stub-model');
  assert.equal(sent.messages[0].role, 'system');
  assert.match(sent.messages[0].content, /MONCHO-CLI/);
  assert.equal(sent.messages.at(-1).content, 'hello');
  assert.equal(sent.stream, false);
});

test('systemPrompt:false omits the agent prompt (used by the context summariser)', async () => {
  const messages = [
    { role: 'system', content: 'You are the context-compaction component of a coding agent.' },
    { role: 'user', content: 'summarise this' }
  ];

  await callOllama(messages, [], false, null, { systemPrompt: false });

  const sent = requests.at(-1);
  assert.equal(sent.messages.length, 2);
  assert.ok(!sent.messages.some((m) => /MONCHO-CLI/.test(m.content)), 'must not leak the agent prompt');
  assert.match(sent.messages[0].content, /context-compaction/);
  assert.deepEqual(sent.tools, undefined);
});

test('the abort signal is honoured', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => callOllama([{ role: 'user', content: 'x' }], [], false, controller.signal));
});

test.after(() => server.close());
