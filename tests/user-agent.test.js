import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * The configurable `User-Agent` (backlog: "lets have an environment variable that lets the
 * user override the user agent", from agent/tmp/headers.example).
 *
 * One variable, `MONCHO_USER_AGENT`, names the program on both outbound surfaces: a
 * provider call (`api/ollama.js#buildHeaders`) and a `web_fetch`
 * (`utils/web-fetch.js#fetchHeaders`). The rule differs by surface, and deliberately:
 *
 *  - the **provider** header is opt-in — with the variable unset no `User-Agent` is sent,
 *    so the request is exactly what it was before the knob existed;
 *  - a **fetch** always presents one — `moncho-cli` when the user configured none, because
 *    a client that names itself nothing is refused by a fair number of hosts.
 *
 * `config/constants.js` reads the environment at import, so the provider cases set the
 * provider variables **before** the first import (a module is cached by URL) and prove the
 * parsing rules by re-importing through a distinct URL; the header that reaches the wire is
 * proven against the real `callOllama()`.
 */

const requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    requests.push({ headers: req.headers, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

// Set the provider *before* the first app import, and leave MONCHO_USER_AGENT unset.
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1/chat/completions`;
process.env.OPENAI_MODEL = 'stub-model';
delete process.env.MONCHO_USER_AGENT;

const { USER_AGENT } = await import('../config/constants.js');
const { callOllama, buildHeaders } = await import('../api/ollama.js');
const { fetchHeaders, FETCH_USER_AGENT_DEFAULT } = await import('../utils/web-fetch.js');

test('the provider User-Agent is opt-in, sent only when MONCHO_USER_AGENT is set', async () => {
  assert.equal(process.env.MONCHO_USER_AGENT, undefined);
  assert.equal(USER_AGENT, null, 'unset must read as null, not as a default');
  assert.ok(!('User-Agent' in buildHeaders()), 'no header is added when none is configured');

  await callOllama([{ role: 'user', content: 'hello' }], [], false, null);
  const sent = requests.at(-1);
  assert.equal(sent.headers['user-agent'], 'node', 'the runtime default is left in place');
  assert.equal(sent.headers['content-type'], 'application/json');
});

test('a blank or whitespace MONCHO_USER_AGENT reads as unset', async () => {
  for (const raw of ['', '   ', '\t']) {
    process.env.MONCHO_USER_AGENT = raw;
    const { USER_AGENT: parsed } = await import(
      `../config/constants.js?blank=${encodeURIComponent(raw)}`
    );
    assert.equal(parsed, null, `${JSON.stringify(raw)} must read as unset`);
  }
  delete process.env.MONCHO_USER_AGENT;
});

test('a configured MONCHO_USER_AGENT is sent as the header, trimmed', async () => {
  process.env.MONCHO_USER_AGENT = '  my-agent/1.0  ';
  const { USER_AGENT: parsed } = await import(
    `../config/constants.js?kept=${encodeURIComponent('my-agent/1.0')}`
  );
  assert.equal(parsed, 'my-agent/1.0');

  assert.equal(buildHeaders('my-agent/1.0')['User-Agent'], 'my-agent/1.0');
  assert.ok(!('User-Agent' in buildHeaders(null)), 'a null user agent adds no header');
  delete process.env.MONCHO_USER_AGENT;
});

test('every provider call carries the configured User-Agent header', async () => {
  const headers = buildHeaders('my-agent/1.0');
  assert.equal(headers['User-Agent'], 'my-agent/1.0');
  assert.equal(headers['Content-Type'], 'application/json');
});

test('a fetch presents moncho-cli when the user configured no user agent', () => {
  assert.equal(FETCH_USER_AGENT_DEFAULT, 'moncho-cli');
  assert.equal(fetchHeaders()['user-agent'], 'moncho-cli');
  assert.equal(fetchHeaders(null)['user-agent'], 'moncho-cli', 'a blank value falls back');
  assert.match(fetchHeaders().accept, /text\/html/);
});

test('a configured MONCHO_USER_AGENT is the user agent a fetch presents', () => {
  assert.equal(fetchHeaders('my-agent/1.0')['user-agent'], 'my-agent/1.0');
});

test.after(() => server.close());
