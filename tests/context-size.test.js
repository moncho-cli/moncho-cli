import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseContextLength,
  contextLengthEndpoint,
  resolveContextSize,
  formatContextLimit,
  CONTEXT_SIZE_SOURCE,
  DEFAULT_CONTEXT_MAX_LENGTH,
} from '../utils/context-size.js';

test('parseContextLength reads the OpenRouter/OpenAI models list', () => {
  const payload = {
    data: [
      { id: 'other/model', context_length: 8000 },
      { id: 'deepseek/deepseek-v4.1-flash', context_length: 1048576, top_provider: { context_length: 999 } },
    ],
  };
  assert.equal(parseContextLength(payload, { model: 'deepseek/deepseek-v4.1-flash' }), 1048576);
  // Falls back to top_provider when the direct field is missing.
  assert.equal(
    parseContextLength({ data: [{ id: 'x', top_provider: { context_length: 131072 } }] }, { model: 'x' }),
    131072,
  );
});

test('parseContextLength reads the Ollama /api/show shapes', () => {
  assert.equal(
    parseContextLength({ model_info: { 'qwen3.context_length': 32768 } }),
    32768,
  );
  assert.equal(parseContextLength({ parameters: 'stop "<|im_start|>"\nnum_ctx 8192\n' }), 8192);
});

test('parseContextLength rejects junk and zero/negative values', () => {
  assert.equal(parseContextLength(null), null);
  assert.equal(parseContextLength('nope'), null);
  assert.equal(parseContextLength({ data: [{ id: 'x', context_length: 0 }] }, { model: 'x' }), null);
  assert.equal(parseContextLength({ context_length: -5 }), null);
});

test('contextLengthEndpoint maps both provider base URLs', () => {
  assert.deepEqual(
    contextLengthEndpoint('https://openrouter.ai/api/v1/chat/completions'),
    { url: 'https://openrouter.ai/api/v1/models', method: 'GET', kind: 'openai' },
  );
  assert.deepEqual(
    contextLengthEndpoint('http://host.containers.internal:11434/api/chat'),
    { url: 'http://host.containers.internal:11434/api/show', method: 'POST', kind: 'ollama' },
  );
  assert.equal(contextLengthEndpoint('not a url'), null);
});

test('resolveContextSize prefers a config override and still reports the real total', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ data: [{ id: 'm', context_length: 1048576 }] }),
  });

  const size = await resolveContextSize({
    configured: 128000,
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'm',
    fetchImpl,
  });

  assert.equal(size.maxTokens, 128000, 'the override is the working budget');
  assert.equal(size.configuredTokens, 128000);
  assert.equal(size.realTokens, 1048576);
  assert.equal(size.source, CONTEXT_SIZE_SOURCE.CONFIGURED);
  assert.equal(formatContextLimit(size), '128.0k configured (total: 1.0M)');
});

test('resolveContextSize uses the API total when no override is configured', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ data: [{ id: 'm', context_length: 262144 }] }),
  });

  const size = await resolveContextSize({
    configured: null,
    baseUrl: 'https://example.test/v1/chat/completions',
    model: 'm',
    fetchImpl,
  });

  assert.equal(size.maxTokens, 262144);
  assert.equal(size.realTokens, 262144);
  assert.equal(size.configuredTokens, null);
  assert.equal(size.source, CONTEXT_SIZE_SOURCE.API);
  assert.equal(formatContextLimit(size), '262.1k (from API)');
});

test('resolveContextSize falls back to the default when the API is unreachable', async () => {
  const fetchImpl = async () => {
    throw new Error('boom');
  };

  const size = await resolveContextSize({
    configured: null,
    baseUrl: 'https://example.test/v1/chat/completions',
    model: 'm',
    fetchImpl,
  });

  assert.equal(size.maxTokens, DEFAULT_CONTEXT_MAX_LENGTH);
  assert.equal(size.realTokens, null);
  assert.equal(size.source, CONTEXT_SIZE_SOURCE.DEFAULT);
  assert.equal(formatContextLimit(size), '128.0k');
});

test('resolveContextSize tolerates a non-ok response and a null fetch', async () => {
  const notOk = await resolveContextSize({
    baseUrl: 'https://example.test/v1/chat/completions',
    model: 'm',
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  assert.equal(notOk.realTokens, null);
  assert.equal(notOk.source, CONTEXT_SIZE_SOURCE.DEFAULT);

  const noFetch = await resolveContextSize({
    configured: 4096,
    baseUrl: 'https://example.test/v1/chat/completions',
    fetchImpl: null,
  });
  assert.equal(noFetch.maxTokens, 4096);
  assert.equal(noFetch.realTokens, null);
});

test('formatContextLimit only spells out the override when it differs from the total', () => {
  assert.equal(
    formatContextLimit({ maxTokens: 1_000_000, configuredTokens: 1_000_000, realTokens: 1_000_000 }),
    '1.0M',
  );
  assert.equal(
    formatContextLimit({ maxTokens: 128000, configuredTokens: 128000, realTokens: null }),
    '128.0k configured',
  );
  assert.equal(formatContextLimit({}), '128.0k');
});
