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
 *  - the agent system prompt is still injected for normal calls (config/prompt.md), and
 *  - `systemPrompt:false` really omits it, which is what lets the context
 *    summariser behind task.md item 8 run as a neutral summariser instead of
 *    answering as Moncho, and
 *  - a retried attempt is reported through the injected `onRetry` hook instead of
 *    the console, so the host can show it as a transient notice
 *    (`docs/interface/notice-overlay`) rather than leaving a stale error line.
 */

const requests = [];
/** How many of the next requests the stub answers with a 502. */
let failNext = 0;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }
    requests.push(parsed);

    // A 502 the retry loop is expected to recover from, on demand (the backlog's
    // report: "i got a 502 error then it worked").
    if (failNext > 0) {
      failNext -= 1;
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end('{"error":"bad gateway"}');
      return;
    }

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

test('a retried attempt is reported through onRetry, not the console', async () => {
  // The stub answers 502 once — exactly the backlog's report — then works.
  const before = requests.length;
  failNext = 1;

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  const retries = [];
  let data;
  try {
    data = await callOllama([{ role: 'user', content: 'hello' }], [], false, null, {
      // The production delay is five seconds; the override keeps the suite quick.
      retryDelayMs: 1,
      onRetry: (report) => retries.push(report),
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(data.message.content, 'stub reply', 'the retry must have succeeded');
  assert.equal(requests.length - before, 2, 'the failed attempt was followed by exactly one retry');
  assert.equal(retries.length, 1, 'exactly one attempt was retried');
  assert.equal(retries[0].attempt, 1);
  assert.equal(retries[0].maxRetries, 3);
  assert.equal(retries[0].delayMs, 1);
  assert.match(retries[0].error.message, /502/);
  assert.deepEqual(warnings, [], 'the hook replaces the console line, it does not add to it');
});

test('a throwing onRetry hook never costs the retry', async () => {
  // Nothing fails here, so the hook is not called at all: a broken notice hook
  // cannot break a healthy call.
  const healthy = await callOllama([{ role: 'user', content: 'hello' }], [], false, null, {
    retryDelayMs: 1,
    onRetry: () => { throw new Error('broken notice hook'); },
  });
  assert.equal(healthy.message.content, 'stub reply');

  // ...and when it *is* called (a real 502), the throw is swallowed and the retry
  // still happens: losing the notice must never cost the user their turn.
  failNext = 1;
  const recovered = await callOllama([{ role: 'user', content: 'hello' }], [], false, null, {
    retryDelayMs: 1,
    onRetry: () => { throw new Error('broken notice hook'); },
  });
  assert.equal(recovered.message.content, 'stub reply', 'the retry still happened');
});

test('the thinking capture resolves inside the project, and refuses to leave it', async () => {
  // The default is the agent/ tree, next to the sessions and the log, so a container
  // run keeps it in the state volume instead of at the root of the user's checkout.
  const { THINKING_FILE } = await import('../config/constants.js');
  assert.equal(THINKING_FILE, 'agent/thinking.md');
  // The rule the provider layer applies: the path goes through the sandbox every file
  // tool uses, so an absolute or escaping value is refused rather than written.
  const { resolveProjectPath } = await import('../utils/path-safety.js');
  assert.ok(resolveProjectPath(THINKING_FILE).startsWith(process.cwd()));
  assert.throws(() => resolveProjectPath('/etc/moncho-thinking.md'), /Absolute paths/);
  assert.throws(() => resolveProjectPath('../../escape.md'), /escapes the project/);
});

test.after(() => server.close());
