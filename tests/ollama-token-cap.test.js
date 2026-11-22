import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The Ollama response-length cap (backlog: "define a limit to the response size to
 * force the model to make a decision sooner").
 *
 * A local thinking model generates into the thousands of tokens and the request dies
 * before it answers, so the call sends a cap on generated tokens. `config/constants.js`
 * reads the environment at import, so the parsing rules are proven by re-importing the
 * module through a distinct URL (a query string is a fresh instance carrying a fresh
 * environment); the placement rule is proven against the pure `buildBody()`.
 *
 * The rule the halves share: the cap is placed where the surface being called actually
 * reads it — `max_tokens` for Ollama's OpenAI-compatible API, `options.num_predict` for
 * its native `/api/chat` — and a provider that is not Ollama receives no cap at all.
 */

delete process.env.OLLAMA_MAX_TOKENS;

const { OLLAMA_MAX_TOKENS, OLLAMA_MAX_TOKENS_DEFAULT } = await import('../config/constants.js');
const { buildBody, isOllamaProvider } = await import('../api/ollama.js');

test('OLLAMA_MAX_TOKENS defaults to a finite cap and can be turned off', async () => {
  assert.equal(OLLAMA_MAX_TOKENS_DEFAULT, 512);
  assert.equal(OLLAMA_MAX_TOKENS, OLLAMA_MAX_TOKENS_DEFAULT, 'an unset variable uses the default');
  for (const raw of ['0', 'off', 'none', 'unlimited']) {
    process.env.OLLAMA_MAX_TOKENS = raw;
    const { OLLAMA_MAX_TOKENS: parsed } = await import(
      `../config/constants.js?off=${encodeURIComponent(raw)}`
    );
    assert.equal(parsed, null, `${JSON.stringify(raw)} must turn the cap off`);
  }
  delete process.env.OLLAMA_MAX_TOKENS;
});

test('an unparseable OLLAMA_MAX_TOKENS falls back to the default', async () => {
  for (const raw of ['-1', 'lots', '   ']) {
    process.env.OLLAMA_MAX_TOKENS = raw;
    const { OLLAMA_MAX_TOKENS: parsed } = await import(
      `../config/constants.js?bad=${encodeURIComponent(raw)}`
    );
    assert.equal(parsed, OLLAMA_MAX_TOKENS_DEFAULT, `${JSON.stringify(raw)} must fall back`);
  }
  delete process.env.OLLAMA_MAX_TOKENS;
});

test('the token cap is placed where each Ollama surface reads it', () => {
  const openaiSurface = buildBody([], [], false, 'http://host:11434/v1/chat/completions');
  assert.equal(openaiSurface.max_tokens, OLLAMA_MAX_TOKENS);
  assert.ok(!('num_predict' in openaiSurface), 'the OpenAI-compatible surface reads max_tokens');

  const nativeSurface = buildBody([], [], false, 'http://host:11434/api/chat');
  assert.equal(nativeSurface.options?.num_predict, OLLAMA_MAX_TOKENS);
  assert.ok(!('max_tokens' in nativeSurface), 'the native surface reads options.num_predict');
});

test('no token cap is sent to an OpenAI-compatible provider', () => {
  const body = buildBody([], [], false, 'https://openrouter.ai/api/v1/chat/completions');
  assert.ok(!('max_tokens' in body), 'a non-Ollama provider keeps its own default');
  assert.ok(!('num_predict' in body));
  assert.equal(isOllamaProvider('https://openrouter.ai/api/v1/chat/completions'), false);
  assert.equal(isOllamaProvider('http://host.containers.internal:11434/api/chat'), true);
});
