import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';

/**
 * The token meter is a view of the context window, so it must be refreshed on
 * every single change — not once per turn (task-backlog: "token consumption
 * should be refreshed more frequently, on every single call").
 *
 * The env is set before the dynamic imports because config/constants.js reads it
 * at module load; Node gives this test file its own process.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-usage-refresh-'));
process.chdir(root);

process.env.OPENAI_BASE_URL = 'http://127.0.0.1:0/v1/chat/completions';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MODEL = 'stub-model';
process.env.CONTEXT_MAX_LENGTH = '100000';

/** Everything that happens during a turn, in order: announcements and requests. */
const events = [];
const requests = [];

/** Chunks a request carried, the system prompt excluded. */
const chunkCountOf = (request) =>
  request.messages.filter((message) => message.role !== 'system').length;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const parsed = JSON.parse(body);
    requests.push(parsed);
    events.push({ type: 'request', chunks: chunkCountOf(parsed) });

    const hasToolResult = parsed.messages.some((message) => message.role === 'tool');
    const message = hasToolResult
      ? { role: 'assistant', content: 'all done' }
      : {
        role: 'assistant',
        content: null,
        tool_calls: [1, 2].map((n) => ({
          id: `call_${n}`,
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'fixture.txt', intent: `read the fixture (${n})` }),
          },
        })),
      };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1/chat/completions`;

const { loadTools } = await import('../utils/tool-loader.js');
const { ConversationManager } = await import('../app/conversation-manager.js');
const { createCompactionNotifier } = await import('../app/compaction-notice.js');

fs.writeFileSync('fixture.txt', 'fixture content\n', 'utf-8');
const { toolFunctions } = await loadTools(() => {});

/** A manager whose provider calls hit the stub above and whose meter is recorded. */
function createManager({ log = () => {}, onContextChange } = {}) {
  const manager = new ConversationManager(toolFunctions, () => [], () => null, { log });
  if (onContextChange) {
    manager.onContextChange = (stats) => {
      events.push({ type: 'stats', chunks: stats.chunks, usage: stats.usage });
      onContextChange(stats);
    };
  }
  return manager;
}

test('every chunk a turn adds is announced before the next provider call', async () => {
  events.length = 0;
  const seen = [];
  const manager = createManager({ onContextChange: (stats) => seen.push(stats.chunks) });

  await manager.processInput('read the fixture twice');

  // The turn is: user, assistant(tool_calls), tool, tool, assistant(final) = 5
  // chunks, and the announcements must climb one at a time to exactly 5.
  assert.equal(manager.chunks.length, 5);
  assert.equal(seen[0], 1, 'the prompt is announced before the first request goes out');
  // 1: the prompt, 1: before the first call, 2: the assistant tool_calls chunk,
  // 3 and 4: the two tool results, 4: before the second call, 5: the reply.
  assert.deepEqual(seen, [1, 1, 2, 3, 4, 4, 5],
    `the window is announced per change, got ${JSON.stringify(seen)}`);

  // Each request was preceded by an announcement carrying the very same chunk
  // count: the meter showed what was about to be sent, not an older number.
  const atRequest = events
    .map((event, index) => ({ event, previous: events[index - 1] }))
    .filter(({ event }) => event.type === 'request');
  assert.ok(atRequest.length >= 2, 'the stub provider saw the tool loop and the reply');
  for (const { event, previous } of atRequest) {
    assert.equal(previous?.type, 'stats', 'an announcement must immediately precede each call');
    assert.equal(previous.chunks, event.chunks, 'the announced number is what the call sent');
  }
});

test('the meter is repainted right before each provider call, not only after the turn', async () => {
  events.length = 0;
  const seen = [];
  const manager = createManager({ onContextChange: (stats) => seen.push(stats.usage) });

  await manager.processInput('read the fixture twice');

  assert.ok(seen.length > 2, `expected a repaint per chunk, got ${seen.length}`);
  // The first announcement already carries the prompt, i.e. it happens before the
  // first request — a once-per-turn repaint could only show the finished window.
  assert.match(seen[0], /tokens \(/);
  assert.equal(manager.contextWindow.stats().usage, seen.at(-1));
});

test('a throwing context listener never costs the user their turn', async () => {
  const manager = new ConversationManager(toolFunctions, () => [], () => null, {
    log: () => {},
    onContextChange: () => { throw new Error('the meter blew up'); },
  });

  await manager.processInput('read the fixture twice');

  assert.equal(manager.chunks.length, 5, 'the turn still completed');
  assert.equal(manager.chunks.at(-1).content, 'all done');
});

test('a manager without a context hook runs the turn unchanged', async () => {
  const manager = createManager();
  assert.equal(manager.notifyContextChange(), null, 'no hook is a no-op, not an error');

  await manager.processInput('read the fixture twice');
  assert.equal(manager.chunks.length, 5);
});

test('repeated announcements still mark a compaction exactly once', () => {
  const lines = [];
  const notifier = createCompactionNotifier({ log: (line) => lines.push(line) });
  const stats = {
    chunks: 4,
    compactions: 1,
    lastCompaction: { olderChunks: 3, keptChunks: 1, olderTokens: 900, afterTokens: 200 },
  };

  // The manager now announces on every chunk and every call; a compaction event
  // must still be reported once, not once per repaint.
  for (let i = 0; i < 10; i += 1) notifier.notify(stats);

  assert.equal(lines.length, 1, 'one compaction event, one notice');
  assert.match(lines[0], /3 older chunk\(s\) -> summary, kept 1 newest chunk\(s\)/);

  notifier.notify({ ...stats, compactions: 2 });
  assert.equal(lines.length, 2, 'a genuinely new compaction is reported again');
});

test('the line CLI keeps one usage line per turn however many chunks the turn added', async () => {
  const lines = [];
  const manager = createManager({ log: (line) => lines.push(String(line)) });

  await manager.processInput('read the fixture twice');

  const usageLines = lines.filter((line) => /\[Context\].*tokens/.test(line));
  assert.equal(usageLines.length, 1, `expected a single usage line, got ${JSON.stringify(usageLines)}`);
  assert.match(usageLines[0], /tokens \(/);
});

test.after(() => server.close());