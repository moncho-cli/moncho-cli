import { defineTool } from '../utils/tool-schema.js';
import { putCapture } from '../utils/capture-store.js';
import { decodeBody, fetchUrl, readBounded, WebFetchError } from '../utils/web-fetch.js';
import {
  DEFAULT_SEARCH_PROVIDER,
  DEFAULT_SEARCH_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  DEFAULT_SEARCH_LINES,
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_LINES,
  MAX_SEARCH_BODY_BYTES,
  SEARCH_PROVIDERS,
  SEARCH_API_KEY_ENV,
  SEARCH_ENDPOINT_ENV,
  WebSearchError,
  validateQuery,
  resolveProvider,
  providerEndpoint,
  searchApiKey,
  buildSearchUrl,
  parseSearchResults,
  formatResults,
  providerError,
  renderSearchDocument,
  searchErrorDocument,
  windowBody,
  shownRange,
} from '../utils/web-search.js';

/**
 * `web_search` — find the URLs worth fetching (`docs/agent/web-search`).
 *
 * `web_fetch` answers *what does this URL say?*, but a model that only has it must already
 * know the address. This tool answers the question that comes first: *which URLs are worth
 * fetching?* It is the same door, one step wider, and it is bounded the same way.
 *
 * The provider is **data** (`utils/web-search.js#SEARCH_PROVIDERS`), with `duckduckgo` as
 * the default, so the tool never learns a second API: it resolves a provider, builds the
 * GET its record describes, and renders whatever came back. The transport is `web_fetch`'s
 * own — `fetchUrl` bounds the scheme, the redirects, the downgrade and the time, and
 * `readBounded` bounds the body — so a search opens no second door out of the sandbox.
 *
 * The answer is the **command document** the rest of the harness already uses
 * (`utils/command-output.js`): a YAML header saying what was searched and how much of the
 * list is shown, `---`, then one numbered block per result. A long list goes into the
 * capture store behind `capture: <id>`, exactly as a long page does, so the model pages or
 * scans it with `read_capture` — one new tool, no second paging grammar.
 *
 * A refusal before the request (an empty query, an unknown provider, a missing key) and a
 * failure during it (a timeout, a refused connection) both answer the JSON envelope with a
 * stable `code`; a provider that answered with **zero results** is a document, because the
 * request worked and "nothing matched" is the news.
 */

/** A JSON envelope for a failure the caller can act on. */
function failure(code, message, guidance = null, extra = {}) {
  return JSON.stringify({
    status: 'error',
    code,
    message,
    ...(guidance ? { guidance } : {}),
    ...extra,
  }, null, 2);
}

/** The provider names a caller may ask for, for a refusal's guidance. */
const providerNames = () => Object.keys(SEARCH_PROVIDERS).join(', ');

const { definition, execute } = defineTool({
  name: 'web_search',
  description:
    'Search the web and get back a list of results — title, URL and snippet — for a query, so the URLs worth fetching can be discovered before `web_fetch` reads one. It answers the same document as `web_fetch`: a YAML header (query, provider, results, shown, truncated, capture), a "---", then one numbered block per result. The provider defaults to DuckDuckGo and is read from the environment: `WEB_SEARCH_API_KEY` holds the key a provider needs (a search without one is refused with MISSING_API_KEY), and `WEB_SEARCH_ENDPOINT` points at another endpoint. A long list shows its first lines with the whole text behind a `capture:` handle for `read_capture`. An empty query, an unknown provider, a missing key, a timeout or a refused connection answers a JSON error with a stable code; a search that matched nothing is a document with zero results. Read-only: it is one GET, and it cannot write, post or upload anything.',
  parameters: {
    properties: {
      query: {
        type: 'string',
        description: 'The words to search for, e.g. "node.js fetch timeout". A non-empty query is required.',
      },
      provider: {
        type: 'string',
        description: `The search provider to use (default "${DEFAULT_SEARCH_PROVIDER}"). One of: ${providerNames()}.`,
      },
      maxResults: {
        type: 'integer',
        description: `How many results to ask the provider for (default ${DEFAULT_SEARCH_RESULTS}, at most ${MAX_SEARCH_RESULTS}).`,
      },
      timeoutMs: {
        type: 'integer',
        description: `Whole-request timeout in milliseconds (default ${DEFAULT_SEARCH_TIMEOUT_MS}, at most ${MAX_SEARCH_TIMEOUT_MS}).`,
      },
      maxLines: {
        type: 'integer',
        description: `How many lines of the result list the document shows (default ${DEFAULT_SEARCH_LINES}, at most ${MAX_SEARCH_LINES}). The rest is behind the capture handle.`,
      },
    },
    required: ['query'],
  },
  async execute(args) {
    const rawQuery = String(args.query ?? '').trim();

    let query;
    try {
      query = validateQuery(rawQuery);
    } catch (error) {
      return failure(error.code, error.message, error.guidance, { query: rawQuery });
    }

    let provider;
    try {
      provider = resolveProvider(args.provider);
    } catch (error) {
      return failure(error.code, error.message, error.guidance, { query });
    }

    const apiKey = searchApiKey(provider);
    if (provider.requiresKey && !apiKey) {
      return failure(
        'MISSING_API_KEY',
        `The ${provider.label} provider needs an API key and none is configured.`,
        `Set ${provider.keyEnv ?? SEARCH_API_KEY_ENV} in the environment, or search with a provider that needs no key.`,
        { query, provider: provider.name },
      );
    }

    const maxResults = Number.isInteger(args.maxResults) && args.maxResults > 0
      ? Math.min(args.maxResults, MAX_SEARCH_RESULTS)
      : DEFAULT_SEARCH_RESULTS;
    const timeoutMs = Number.isInteger(args.timeoutMs) && args.timeoutMs > 0
      ? Math.min(args.timeoutMs, MAX_SEARCH_TIMEOUT_MS)
      : DEFAULT_SEARCH_TIMEOUT_MS;

    let requestUrl;
    try {
      requestUrl = buildSearchUrl(provider, query, {
        apiKey,
        maxResults,
        endpoint: providerEndpoint(provider),
      });
    } catch (error) {
      return failure(error.code ?? 'SEARCH_FAILED', error.message, error.guidance, { query, provider: provider.name });
    }

    let fetched;
    try {
      fetched = await fetchUrl(requestUrl, { timeoutMs });
    } catch (error) {
      if (error instanceof WebFetchError) {
        return failure(error.code, error.message, error.guidance, { query, provider: provider.name });
      }
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      if (timeout) {
        return failure('TIMEOUT', `The search timed out after ${timeoutMs}ms.`, 'Retry with a larger timeoutMs, or search again later.', { query, provider: provider.name });
      }
      return failure(
        'SEARCH_FAILED',
        `The search request failed: ${error?.message ?? 'unknown error'}.`,
        'Check the endpoint is reachable from here, and retry.',
        { query, provider: provider.name },
      );
    }

    const { response } = fetched;
    let bounded;
    try {
      bounded = await readBounded(response, MAX_SEARCH_BODY_BYTES);
    } catch (error) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      return failure(
        timeout ? 'TIMEOUT' : 'SEARCH_FAILED',
        timeout ? `The answer did not finish within ${timeoutMs}ms.` : `Reading the answer failed: ${error?.message ?? 'unknown error'}.`,
        timeout ? 'Retry with a larger timeoutMs.' : 'Retry the search; the connection was cut mid-body.',
        { query, provider: provider.name },
      );
    }

    const decoded = decodeBody(bounded.bytes, { contentType: response.headers?.get?.('content-type') || 'application/json' });

    let payload;
    try {
      payload = JSON.parse(decoded.text);
    } catch {
      // A server answer that is not JSON is still an answer: report the status and a head
      // of the body rather than pretending the parse failure is the whole story.
      return failure(
        'INVALID_RESPONSE',
        `The provider answered with a non-JSON body (http ${response.status}).`,
        'The endpoint may be wrong, or the provider may be down. Check WEB_SEARCH_ENDPOINT.',
        { query, provider: provider.name, http_status: response.status, body: decoded.text.slice(0, 500) },
      );
    }

    const reported = providerError(payload);
    if (reported) {
      return failure(
        'PROVIDER_ERROR',
        `The ${provider.label} provider reported an error: ${reported}`,
        'Check the query and the API key, then retry.',
        { query, provider: provider.name, http_status: response.status },
      );
    }

    const results = parseSearchResults(payload, { resultsPath: provider.resultsPath });
    const text = formatResults(results);
    const window = windowBody(text, Number.isInteger(args.maxLines) && args.maxLines > 0 ? args.maxLines : DEFAULT_SEARCH_LINES);
    const capture = window.truncated ? putCapture({ command: `web_search ${query}`, text }) : null;

    return renderSearchDocument({
      query,
      provider: provider.name,
      results: results.length,
      text: window.text,
      shown: window.shown,
      truncated: window.truncated,
      mode: window.mode,
      capture: capture ? capture.id : null,
      range: capture ? shownRange(window) : null,
    });
  },
});

export { definition, execute, failure };
