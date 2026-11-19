import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';

/**
 * End-to-end verification of the ConversationManager against a stub provider.
 *
 * Covers the three behaviours the harness work is responsible for:
 *  - task.md item 6: the tool-call `intent` is printed and stored in the tool
 *    result chunk that goes back into the model context;
 *  - task.md item 3: the context window's token usage is reported;
 *  - task.md item 8: an over-budget window is compacted (older 80% summarised
 *    with a *neutral* call, newest 20% kept verbatim) before the next model call.
 *
 * The env is set before the dynamic imports because config/constants.js reads it
 * at module load; Node gives this test file its own process.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-manager-test-'));
process.chdir(root);
fs.writeFileSync('fixture.txt', 'fixture content\n', 'utf-8');

process.env.OPENAI_BASE_URL = 'http://127.0.0.1:0/v1/chat/completions';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MODEL = 'stub-model';
process.env.CONTEXT_MAX_LENGTH = '120';

const requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const parsed = JSON.parse(body);
    requests.push(parsed);

    const isSummarizer = parsed.messages.some(
      (m) => m.role === 'system' && /context-compaction component/.test(m.content)
    );
    const alreadyToolCalled = parsed.messages.some((m) => m.role === 'tool');

    let message;
    if (isSummarizer) {
      message = { role: 'assistant', content: 'SUMMARY: intent, work done, pending.' };
    } else if (!alreadyToolCalled) {
      message = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'fixture.txt', intent: 'load the fixture for verification' })
          }
        }]
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
const { ConversationManager, detectCompactionRequest } = await import('../app/conversation-manager.js');
const { ContextWindow } = await import('../app/context-window.js');
const { CONTEXT_MAX_LENGTH } = await import('../config/constants.js');
const { getContextWindow } = await import('../utils/host.js');

const lines = [];
const log = (message) => lines.push(String(message));

const { tools, toolFunctions } = await loadTools(() => {});

test('processInput runs the tool loop, prints intents, and keeps them in context', async () => {
  assert.equal(CONTEXT_MAX_LENGTH, 120, 'the test budget must be applied at import time');

  const manager = new ConversationManager(toolFunctions, () => tools, () => null, { log });
  await manager.processInput('read the fixture');

  // 1. intent printing (task.md item 6, visible half)
  assert.ok(lines.some((l) => l.includes('intent: load the fixture for verification')), 'intent must be printed');
  assert.ok(lines.some((l) => l.includes('-> Calling read_file')), 'the call itself must be printed');

  // 2. the intent is part of the tool-result chunk (task.md item 6, context half)
  const toolChunk = manager.chunks.find((c) => c.role === 'tool');
  assert.ok(toolChunk, 'a tool result chunk must exist');
  assert.match(toolChunk.content, /^intent: load the fixture for verification\n/);
  assert.ok(toolChunk.content.includes('fixture content'), 'the tool output must be preserved');

  // 3. token usage is reported (task.md item 3)
  assert.ok(lines.some((l) => /\[Context\] .*tokens/.test(l)), 'token usage must be reported');
  assert.ok(manager.contextWindow.stats().estimatedTokens > 0);

  // 4. the final assistant chunk is stored and the window ends with it
  assert.equal(manager.chunks.at(-1).role, 'assistant');
  assert.equal(manager.chunks.at(-1).content, 'all done');

  // The live window is reachable by the stateless compact_context tool.
  assert.equal(getContextWindow(), manager.contextWindow);
});

test('an over-budget window is compacted with a neutral summariser call', () => {
  assert.ok(lines.some((l) => l.includes('[Context] Compacted')), 'compaction must have run');

  const summarizerRequests = requests.filter((r) =>
    r.messages.some((m) => m.role === 'system' && /context-compaction component/.test(m.content))
  );
  assert.ok(summarizerRequests.length >= 1, 'the summariser must have been called');

  for (const request of summarizerRequests) {
    assert.ok(
      !request.messages.some((m) => /MONCHO-CLI/.test(m.content || '')),
      'the summariser call must not inherit the agent system prompt'
    );
    assert.match(request.messages[1].content, /Summarise the following/);
  }

  // The summary chunk then travels in the *next* normal request.
  const mainRequests = requests.filter(
    (r) => !r.messages.some((m) => m.role === 'system' && /context-compaction component/.test(m.content))
  );
  const last = mainRequests.at(-1);
  assert.ok(
    last.messages.some((m) => /compacted summary of earlier context/.test(m.content || '')),
    'the summary chunk must be sent in the following request'
  );
});

test('maybeCompact keeps the newest chunks and evicts the rest', async () => {
  const window = new ContextWindow({ maxTokens: 40, tools: () => tools });
  const manager = new ConversationManager(toolFunctions, () => tools, () => null, {
    log: () => {},
    contextWindow: window
  });

  window.addMany([
    { role: 'user', content: 'A'.repeat(200) },
    { role: 'assistant', content: 'B'.repeat(200) },
    { role: 'user', content: 'latest question' }
  ]);

  const report = await manager.maybeCompact(null, { force: true });
  assert.equal(report.compacted, true);
  assert.equal(window.chunks[0].compacted, true);
  assert.equal(window.chunks.at(-1).content, 'latest question');
  assert.ok(!window.chunks.some((c) => c.content === 'A'.repeat(200)), 'evicted chunks must be gone');
});

test('a summariser failure never breaks the task loop', async () => {
  const reported = [];
  const failingWindow = {
    chunks: [{ role: 'user', content: 'x' }],
    maxTokens: 10,
    compactions: [],
    needsCompaction: () => true,
    compact: async () => { throw new Error('provider down'); },
    stats: () => ({}),
    usage: () => 'rubbish'
  };

  const manager = new ConversationManager(toolFunctions, () => [], () => null, {
    log: (m) => reported.push(String(m)),
    contextWindow: failingWindow
  });

  const result = await manager.maybeCompact(null, { force: true });
  assert.equal(result.compacted, false);
  assert.equal(result.reason, 'error');
  assert.ok(reported.some((m) => m.includes('[Context] Compaction skipped')), 'failures must be reported');
});

test('the compaction announces itself in the transcript before it runs', async () => {
  const transcript = [];
  let announcedBeforeCompact = false;
  const compactingWindow = {
    chunks: [{ role: 'user', content: 'x' }],
    maxTokens: 10,
    compactions: [],
    needsCompaction: () => true,
    compact: async () => {
      // The announcement must already be on the transcript when the window is
      // rewritten: the summariser call takes time, and the thread must not go
      // quiet while it runs.
      announcedBeforeCompact = transcript.some((line) => line.includes('Compaction process started'));
      return {
        compacted: true,
        olderChunks: 2,
        keptChunks: 1,
        olderTokens: 900,
        afterTokens: 120,
        usage: '120/1000 tokens'
      };
    },
    stats: () => ({}),
    usage: () => '120/1000 tokens'
  };

  const manager = new ConversationManager(toolFunctions, () => [], () => null, {
    log: (message) => transcript.push(String(message)),
    contextWindow: compactingWindow
  });

  await manager.maybeCompact(null, { force: true });

  assert.ok(announcedBeforeCompact, 'the starting line must be logged before the window is rewritten');
  assert.ok(
    transcript.some((line) => line.includes('[Context] Compaction process started')),
    'the transcript must say that the compaction started'
  );
  assert.ok(
    transcript.some((line) => line.includes('[Context] Compacted')),
    'the finishing line still follows it'
  );
});

test('detectCompactionRequest only fires on deferred compact_context results', () => {
  assert.equal(detectCompactionRequest(JSON.stringify({ code: 'COMPACTION_REQUESTED', defer: true })), true);
  assert.equal(detectCompactionRequest(JSON.stringify({ code: 'COMPACTION_REQUESTED', defer: false })), false);
  assert.equal(detectCompactionRequest(JSON.stringify({ status: 'skipped' })), false);
  assert.equal(detectCompactionRequest('not json'), false);
});

test('a recovered provider failure becomes a notice, never a transcript line', () => {
  const notices = [];
  const transcript = [];
  const manager = new ConversationManager(toolFunctions, () => tools, () => null, {
    log: (message) => transcript.push(String(message)),
    onNotice: (kind, text, options) => notices.push({ kind, text, ...options }),
  });

  // What the onRetry hook of api/ollama.js calls for an attempt that is retried.
  const retry = { attempt: 1, maxRetries: 3, delayMs: 5000, error: new Error('HTTP error! status: 502') };
  manager.notifyRetry(retry);

  assert.equal(notices.length, 1, 'the attempt must be raised as a notice');
  assert.equal(notices[0].kind, 'warn', 'a retried attempt is not an error yet');
  assert.equal(notices[0].code, 'retry', 'so the host can take it down when the turn lands');
  assert.match(notices[0].text, /attempt 1\/3/);
  assert.match(notices[0].text, /status: 502/);
  assert.deepEqual(transcript, [], 'the transcript — the permanent record — must stay clean');

  // A failure nothing recovered from is news *and* history: it ends the task.
  manager.notifyNotice('error', 'Provider call failed: connect ECONNREFUSED', { code: 'provider-failure' });
  assert.equal(notices.length, 2);
  assert.equal(notices[1].kind, 'error');

  // Presentation only: a hook that throws, and no hook at all, both stay harmless.
  const throwing = new ConversationManager(toolFunctions, () => tools, () => null, {
    log: () => {},
    onNotice: () => { throw new Error('broken overlay'); },
  });
  assert.equal(throwing.notifyNotice('info', 'x'), null, 'a broken hook is swallowed');
  const hookless = new ConversationManager(toolFunctions, () => tools, () => null, { log: () => {} });
  assert.equal(hookless.notifyRetry(retry), null, 'without a hook the notice is dropped, not logged');
});

test.after(() => server.close());
