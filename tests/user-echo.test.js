import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';

import { formatUserEcho, formatTranscript, USER_ECHO_HEADER, USER_ECHO_PREFIX } from '../app/tui-render.js';

/**
 * The conversation view is a dialogue, so the user's own message is echoed into
 * the transcript too (task-backlog item: "conversation should include the
 * messages from the user too").
 *
 * The echo is *presentation only*: the chunk handed to the model is the prompt
 * itself, verbatim. These cases prove both halves — the announcement from
 * ConversationManager and the rendering done by formatUserEcho().
 *
 * The env is set before any module that reaches config/constants.js is imported
 * (including tests/support/tui-harness.js, which pulls in app/tui.js), because
 * that module reads the provider URL at load time. Node gives this test file its
 * own process.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-user-echo-'));
process.chdir(root);

process.env.OPENAI_BASE_URL = 'http://127.0.0.1:0/v1/chat/completions';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MODEL = 'stub-model';
process.env.CONTEXT_MAX_LENGTH = '100000';

/** Every event the host sees, in order: the echo must precede the request. */
const events = [];
const requests = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    requests.push(JSON.parse(body));
    events.push('request');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1/chat/completions`;

const { ConversationManager } = await import('../app/conversation-manager.js');
const { withTui, visible, plainText } = await import('./support/tui-harness.js');

/** A manager whose provider calls hit the stub above. */
function createManager(options = {}) {
  return new ConversationManager({}, () => [], () => null, { log: () => {}, ...options });
}

test('processInput announces the user message through onUserMessage, before the model call', async () => {
  events.length = 0;
  const seen = [];
  const prompt = 'please read the fixture';

  const manager = createManager({
    onUserMessage: (text) => {
      seen.push(text);
      events.push('echo');
    },
  });

  await manager.processInput(prompt);

  assert.deepEqual(seen, [prompt], 'the hook receives the prompt, exactly once');
  assert.equal(events[0], 'echo', 'the echo happens before the request is sent');
  assert.ok(events.includes('request'), 'the stub provider was called');

  // The echo is display only: the chunk the model receives is the raw prompt.
  const chunk = manager.chunks.find((c) => c.role === 'user');
  assert.deepEqual(chunk, { role: 'user', content: prompt });
  assert.ok(!chunk.content.startsWith(USER_ECHO_PREFIX), 'the quote prefix never reaches the model');

  const sent = requests.at(-1).messages.find((m) => m.role === 'user');
  assert.equal(sent.content, prompt);
});

test('a manager without the hook, and a throwing hook, both keep the turn working', async () => {
  const silent = createManager();
  await silent.processInput('no echo configured');
  assert.equal(silent.chunks[0].content, 'no echo configured');

  const fragile = createManager({
    onUserMessage: () => { throw new Error('the renderer blew up'); },
  });
  await fragile.processInput('a broken echo must not cost the prompt');
  assert.equal(fragile.chunks[0].content, 'a broken echo must not cost the prompt');
  assert.equal(fragile.chunks.at(-1).content, 'ok', 'the turn still completed');
});

test('formatUserEcho() labels the message and quotes every one of its lines', () => {
  assert.equal(USER_ECHO_HEADER, 'You:');
  assert.equal(USER_ECHO_PREFIX, '> ');

  assert.equal(formatUserEcho('one line'), 'You:\n> one line');
  assert.deepEqual(formatUserEcho('first\nsecond\n').split('\n'), [
    'You:',
    '> first',
    '> second',
    '> ',
  ]);

  // Model-ish output cannot break the transcript: it is sanitised first.
  assert.equal(formatUserEcho('\x1b[31mred'), 'You:\n> red');
  assert.equal(formatUserEcho(''), 'You:\n> ');
});

test('the echoed message renders as a coloured quote, not as raw markdown', async () => {
  assert.equal(formatTranscript('> quoted line'), '{green-fg}│ quoted line{/green-fg}');
  assert.equal(
    formatTranscript('> **bold** and `code`'),
    '{green-fg}│ {bold}bold{/bold} and {cyan-fg}code{/cyan-fg}{/green-fg}',
  );

  await withTui(async (tui, { painted }) => {
    tui.log(formatUserEcho('hello there\nsecond line'));
    await new Promise((resolve) => setImmediate(resolve));

    const content = visible(tui);
    assert.match(content, /You:/);
    assert.match(content, /│ hello there/);
    assert.match(content, /│ second line/);
    // the quote markers themselves never show up as raw text
    assert.doesNotMatch(content, /^> /m);
    assert.match(plainText(painted()), /│ hello there/);
  });
});

test.after(() => server.close());
