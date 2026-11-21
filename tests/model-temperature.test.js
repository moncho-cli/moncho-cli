import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * The model-call temperature knob (backlog #61).
 *
 * `config/constants.js` reads the environment at import, so this file starts its stub
 * server and sets the provider variables **before** the first import — a module is
 * cached by URL, so an import that ran earlier would keep the default provider. The
 * parsing rules are proven by re-importing the module through a distinct URL (a query
 * string is a fresh instance carrying a fresh environment); the configured case that
 * reaches the wire is proven in `tests/ollama-provider.test.js`.
 *
 * The rule the two halves share: the temperature is **absent** unless the user asked
 * for it, so the provider's own default applies exactly as it did before the knob
 * existed, and a value that cannot be used never silently changes how the model answers.
 */

const requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try { requests.push(JSON.parse(body)); } catch { /* ignore */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

// Set the provider *before* the first app import, and leave MODEL_TEMPERATURE unset.
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1/chat/completions`;
process.env.OPENAI_MODEL = 'stub-model';
delete process.env.MODEL_TEMPERATURE;

const { MODEL_TEMPERATURE } = await import('../config/constants.js');
const { callOllama } = await import('../api/ollama.js');

test('MODEL_TEMPERATURE is unset unless the user configures one', () => {
  assert.equal(process.env.MODEL_TEMPERATURE, undefined);
  assert.equal(MODEL_TEMPERATURE, null);
});

test('an out-of-range or unparseable MODEL_TEMPERATURE reads as unset', async () => {
  for (const raw of ['-1', '3', 'hot', '', '   ']) {
    process.env.MODEL_TEMPERATURE = raw;
    const { MODEL_TEMPERATURE: parsed } = await import(
      `../config/constants.js?unset=${encodeURIComponent(raw)}`
    );
    assert.equal(parsed, null, `${JSON.stringify(raw)} must read as unset`);
  }
  delete process.env.MODEL_TEMPERATURE;
});

test('a usable MODEL_TEMPERATURE is kept as a number, boundary values included', async () => {
  for (const [raw, expected] of [['0', 0], ['0.7', 0.7], ['2', 2]]) {
    process.env.MODEL_TEMPERATURE = raw;
    const { MODEL_TEMPERATURE: parsed } = await import(
      `../config/constants.js?keep=${encodeURIComponent(raw)}`
    );
    assert.equal(parsed, expected, `${raw} must be kept`);
  }
  delete process.env.MODEL_TEMPERATURE;
});

test('an unset MODEL_TEMPERATURE leaves the key out of the request body', async () => {
  await callOllama([{ role: 'user', content: 'hello' }], [], false, null);
  const sent = requests.at(-1);
  assert.equal(sent.model, 'stub-model');
  assert.ok(!('temperature' in sent), 'no temperature must be sent when none is configured');
});

test.after(() => server.close());
