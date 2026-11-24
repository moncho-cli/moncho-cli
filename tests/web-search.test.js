import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  DEFAULT_SEARCH_PROVIDER, DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS,
  SEARCH_PROVIDERS, SEARCH_API_KEY_ENV, SEARCH_ENDPOINT_ENV,
  WebSearchError, validateQuery, resolveProvider, providerEndpoint, searchApiKey,
  buildSearchUrl, parseSearchResults, formatResults, providerError,
} from '../utils/web-search.js';
import { windowBody } from '../utils/web-fetch.js';
import { execute as webSearchExecute } from '../tools/web_search.js';
import { READ_ONLY_TOOLS, refusalForMode } from '../app/mode-policy.js';
import { toolFamily, toolColorFor } from '../app/tool-palette.js';
import { getCapture, clearCaptures } from '../utils/capture-store.js';
import { execute as readCaptureExecute } from '../tools/read_capture.js';

/**
 * Proof for `web_search` (docs/agent/web-search): the pure provider seam — the query
 * validation, the provider registry, the URL builder and the defensive parser — the tool
 * end to end against a **local** stub provider (the suite needs no network), and the
 * registrations that decide where a search may run and how it is painted.
 */

/** A provider answer shaped the way the DuckDuckGo record expects. */
const ANSWER = {
  organic_results: [
    { position: 1, title: 'Node.js fetch', link: 'https://example.com/a', snippet: 'timeouts' },
    { position: 2, title: 'AbortSignal', url: 'https://example.com/b', description: 'how to abort' },
    {},
  ],
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const q = url.searchParams.get('q');
  if (q === 'boom') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'rate limited' }));
    return;
  }
  if (q === 'notjson') {
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<html>bad gateway</html>');
    return;
  }
  if (q === 'empty') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ organic_results: [] }));
    return;
  }
  if (q === 'many') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      organic_results: Array.from({ length: 60 }, (_, i) => ({
        position: i + 1, title: `result ${i + 1}`, link: `https://example.com/${i + 1}`, snippet: `snippet ${i + 1}`,
      })),
    }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(ANSWER));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/search`;
test.after(() => server.close());

/** Run a search against the local stub, with the key and endpoint the tool reads. */
async function search(args) {
  process.env[SEARCH_ENDPOINT_ENV] = base;
  process.env[SEARCH_API_KEY_ENV] = 'test-key';
  try {
    return await webSearchExecute({ intent: 'probe', ...args });
  } finally {
    delete process.env[SEARCH_ENDPOINT_ENV];
    delete process.env[SEARCH_API_KEY_ENV];
  }
}

/** The YAML header fields of a document, as a plain object. */
function headerOf(document) {
  const [head] = document.split('\n---\n');
  const fields = {};
  for (const line of head.split('\n')) {
    const at = line.indexOf(': ');
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 2).replace(/^"|"$/g, '');
  }
  return fields;
}

/** The payload of a document (everything after the `---` delimiter). */
const payloadOf = (document) => document.split('\n---\n').slice(1).join('\n---\n');

// ---------------------------------------------------------------------------
// the pure provider seam
// ---------------------------------------------------------------------------

test('validateQuery refuses an empty query and trims a real one', () => {
  assert.equal(validateQuery('  node fetch  '), 'node fetch');
  for (const bad of ['', '   ', null, undefined]) {
    assert.throws(() => validateQuery(bad), (error) => {
      assert.equal(error.code, 'INVALID_QUERY');
      assert.match(error.guidance, /words to search for/);
      return true;
    });
  }
});

test('resolveProvider defaults to duckduckgo and refuses an unknown name', () => {
  assert.equal(DEFAULT_SEARCH_PROVIDER, 'duckduckgo');
  assert.equal(resolveProvider().name, 'duckduckgo');
  assert.equal(resolveProvider('DuckDuckGo').name, 'duckduckgo', 'the name is case-insensitive');
  assert.equal(SEARCH_PROVIDERS.duckduckgo.requiresKey, true);

  assert.throws(() => resolveProvider('nope'), (error) => {
    assert.equal(error.code, 'UNKNOWN_PROVIDER');
    assert.match(error.guidance, /duckduckgo/);
    return true;
  });
});

test('buildSearchUrl spells the query, engine, key and count the way the provider declares', () => {
  const provider = resolveProvider('duckduckgo');
  const url = new URL(buildSearchUrl(provider, 'node fetch', { apiKey: 'k', maxResults: 5 }));

  // The record, not the code, decides the parameter names.
  assert.equal(url.searchParams.get('engine'), 'duckduckgo');
  assert.equal(url.searchParams.get('q'), 'node fetch');
  assert.equal(url.searchParams.get('api_key'), 'k');
  assert.equal(url.searchParams.get('num'), '5');

  // No key means no key parameter at all, never an empty one.
  const keyless = new URL(buildSearchUrl(provider, 'x', { apiKey: null }));
  assert.equal(keyless.searchParams.has('api_key'), false);

  // A count past the ceiling is clamped rather than sent.
  const capped = new URL(buildSearchUrl(provider, 'x', { maxResults: 9999 }));
  assert.equal(capped.searchParams.get('num'), String(MAX_SEARCH_RESULTS));
  assert.equal(DEFAULT_SEARCH_RESULTS, 10);
});

test('providerEndpoint and searchApiKey read the environment, and a blank key is unset', () => {
  const provider = resolveProvider('duckduckgo');
  assert.equal(providerEndpoint(provider, {}), provider.endpoint);
  assert.equal(providerEndpoint(provider, { [SEARCH_ENDPOINT_ENV]: 'http://stub/' }), 'http://stub/');
  assert.equal(searchApiKey(provider, { [SEARCH_API_KEY_ENV]: '  k  ' }), 'k');
  assert.equal(searchApiKey(provider, { [SEARCH_API_KEY_ENV]: '   ' }), null, 'a blank key is not a key');
  assert.equal(searchApiKey(provider, {}), null);
});

test('parseSearchResults normalises the field names and drops an empty entry', () => {
  const results = parseSearchResults(ANSWER);

  assert.equal(results.length, 2, 'the entry with neither a title nor a URL is dropped');
  assert.deepEqual(results[0], {
    position: 1, title: 'Node.js fetch', url: 'https://example.com/a', snippet: 'timeouts',
  });
  // `url` and `description` are the fallbacks for `link` and `snippet`.
  assert.equal(results[1].url, 'https://example.com/b');
  assert.equal(results[1].snippet, 'how to abort');

  // A payload with no list at all is an empty result, never a crash.
  assert.deepEqual(parseSearchResults({}), []);
  assert.deepEqual(parseSearchResults(null), []);
  // A `results` key is accepted when the provider's own path is absent.
  assert.equal(parseSearchResults({ results: [{ title: 't', link: 'u' }] }).length, 1);
});

test('formatResults lays out one numbered block per result', () => {
  const text = formatResults(parseSearchResults(ANSWER));
  assert.match(text, /^1\. Node\.js fetch\n {3}https:\/\/example\.com\/a\n {3}timeouts/);
  assert.match(text, /\n\n2\. AbortSignal\n/);
  // An untitled result still gets a line rather than a blank block.
  assert.equal(formatResults([{ position: 1, title: '', url: 'https://x/' }]), '1. (untitled)\n   https://x/');
  assert.equal(formatResults([]), '');
});

test('windowBody shows a list from the top and reports what it cut', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `l${i + 1}`).join('\n');
  const all = windowBody('a\nb', 10);
  assert.deepEqual({ shown: all.shown, truncated: all.truncated, mode: all.mode }, { shown: 2, truncated: false, mode: 'all' });

  const clipped = windowBody(lines, 5);
  assert.equal(clipped.mode, 'head');
  assert.equal(clipped.shown, 5);
  assert.equal(clipped.total, 50);
  assert.equal(clipped.truncated, true);
});

// ---------------------------------------------------------------------------
// the tool, against a local stub provider
// ---------------------------------------------------------------------------

test('web_search answers a result list as a document of numbered blocks', async () => {
  const document = await search({ query: 'node fetch timeout' });
  const header = headerOf(document);

  assert.equal(header.status, 'success');
  assert.equal(header.query, 'node fetch timeout');
  assert.equal(header.provider, 'duckduckgo');
  assert.equal(header.results, '2');
  assert.equal(header.mode, 'all');
  assert.match(payloadOf(document), /^1\. Node\.js fetch\n {3}https:\/\/example\.com\/a/, 'the URL is on its own line');
});

test('web_search reports zero results as a document, not an error', async () => {
  const document = await search({ query: 'empty' });
  const header = headerOf(document);

  assert.equal(header.status, 'success');
  assert.equal(header.results, '0');
  assert.equal(payloadOf(document), '(no output)', 'nothing matched is the news, not a failure');
});

test('web_search hands a long list to the capture store for read_capture', async () => {
  clearCaptures();
  const document = await search({ query: 'many', maxLines: 5 });
  const header = headerOf(document);

  assert.equal(header.mode, 'head');
  assert.equal(header.shown, '5');
  assert.equal(header.truncated, 'true');
  assert.equal(header.results, '60');
  const handle = Number(header.capture);
  assert.ok(handle > 0, 'the rest is not thrown away');
  assert.ok(getCapture(handle), 'and the handle really resolves');

  // One new tool, no second paging grammar: read_capture reads it.
  const page = await readCaptureExecute({ capture: handle, pattern: 'result 60', intent: 'scan the tail' });
  assert.match(page, /result 60/);
});

test('web_search refuses an empty query, an unknown provider and a missing key with a stable code', async () => {
  const empty = JSON.parse(await search({ query: '   ' }));
  assert.equal(empty.status, 'error');
  assert.equal(empty.code, 'INVALID_QUERY');

  const unknown = JSON.parse(await search({ query: 'x', provider: 'nope' }));
  assert.equal(unknown.code, 'UNKNOWN_PROVIDER');
  assert.match(unknown.guidance, /duckduckgo/);

  // A provider that needs a key and has none is a refusal naming the variable, not a 401.
  process.env[SEARCH_ENDPOINT_ENV] = base;
  delete process.env[SEARCH_API_KEY_ENV];
  try {
    const missing = JSON.parse(await webSearchExecute({ query: 'x', intent: 'probe' }));
    assert.equal(missing.code, 'MISSING_API_KEY');
    assert.match(missing.guidance, new RegExp(SEARCH_API_KEY_ENV));
  } finally {
    delete process.env[SEARCH_ENDPOINT_ENV];
  }
});

test('web_search reports a provider error and a non-JSON body without pretending they are transport failures', async () => {
  const provider = JSON.parse(await search({ query: 'boom' }));
  assert.equal(provider.status, 'error');
  assert.equal(provider.code, 'PROVIDER_ERROR');
  assert.match(provider.message, /rate limited/);

  const notJson = JSON.parse(await search({ query: 'notjson' }));
  assert.equal(notJson.code, 'INVALID_RESPONSE');
  assert.equal(notJson.http_status, 502);
  assert.match(notJson.body, /bad gateway/);
});

// ---------------------------------------------------------------------------
// where a search may run, and how it is painted
// ---------------------------------------------------------------------------

test('web_search is a read-only tool in the read family', () => {
  assert.ok(READ_ONLY_TOOLS.includes('web_search'), 'a search reads and writes nothing');
  assert.equal(refusalForMode('chat', { name: 'web_search', args: {} }), null, 'Chat may search');
  assert.equal(refusalForMode('design', { name: 'web_search', args: {} }), null, 'Design may search');
  assert.equal(toolFamily('web_search'), 'read');
  assert.equal(toolColorFor('web_search'), 'bright-cyan');
});
