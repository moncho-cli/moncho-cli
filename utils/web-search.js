import {
  renderYamlHeader, OUTPUT_DELIMITER, EMPTY_OUTPUT, CAPTURE_HINT,
} from './command-output.js';
import { windowBody, shownRange } from './web-fetch.js';

/**
 * Searching the web, through one provider seam (`docs/agent/web-search`).
 *
 * `web_fetch` answers *what does this URL say?*. This module answers the question that
 * comes **before** it: *which URLs are worth fetching?* A model that only has `web_fetch`
 * must already know the address, which is exactly the knowledge a search supplies.
 *
 * The design is the same door, one step wider, and the widening is bounded the same way:
 *
 *  - **the provider is data, not code.** `SEARCH_PROVIDERS` maps a name to a record that
 *    says where to ask (`endpoint`), how to spell the request (`params`), where the results
 *    live in the answer (`resultsPath`) and whether a key is needed. Adding a provider is
 *    one entry; the tool never learns a second API.
 *  - **one provider is the default.** `duckduckgo` is what a session searches with unless
 *    it asks for another, and the record carries the SearchApi.io DuckDuckGo engine.
 *  - **the key is the user's, and its absence is a refusal, not a crash.** A provider that
 *    needs a key answers `MISSING_API_KEY` naming the variable to set, so the model can say
 *    what is wrong instead of reporting a 401 as a mystery.
 *  - **the transport is `web_fetch`'s.** `fetchUrl` already bounds the scheme, the
 *    redirects, the downgrade and the time, and `readBounded` bounds the body. A search is
 *    a GET of a JSON document, so it reuses that door rather than opening a second one.
 *
 * Nothing here touches disk or a terminal, and the request is always a **GET**: a search
 * reads an index, and a body-carrying method would be a write aimed at a stranger.
 */

/** The provider a session searches with unless it names another. */
export const DEFAULT_SEARCH_PROVIDER = 'duckduckgo';

/** How many results a search asks for, and the ceiling on that. */
export const DEFAULT_SEARCH_RESULTS = 10;
export const MAX_SEARCH_RESULTS = 50;

/** How long one search may take, unless the caller asks for something else. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 30000;
export const MAX_SEARCH_TIMEOUT_MS = 300000;

/** How many lines of the result list a document shows, and the ceiling on that. */
export const DEFAULT_SEARCH_LINES = 200;
export const MAX_SEARCH_LINES = 1000;

/**
 * How much of a provider's answer is read, in bytes.
 *
 * A result list is small — a few dozen JSON objects — so this is generous by an order of
 * magnitude: it exists to stop a runaway, not to ration a search. It is the same bound
 * `web_fetch` applies to a body, reused rather than invented.
 */
export const MAX_SEARCH_BODY_BYTES = 4 * 1024 * 1024;

/** The environment variable a provider's key is read from, when it needs one. */
export const SEARCH_API_KEY_ENV = 'WEB_SEARCH_API_KEY';

/**
 * The environment variable that points a provider at another endpoint.
 *
 * It exists for two honest reasons: a self-hosted or mirrored search backend is a real
 * deployment, and a test needs a hermetic server instead of the network. It is read
 * **when a search runs**, not once at import, for the same reason
 * `config/constants.js#hostFenceEnabled` reads late — a value frozen at module load could
 * not be pointed at a stub, and a check that silently stops checking depending on where it
 * runs is worse than the knob it guards.
 */
export const SEARCH_ENDPOINT_ENV = 'WEB_SEARCH_ENDPOINT';

/**
 * The providers a search may use, as data.
 *
 * `params` names the query parameters the endpoint expects, so the API's spelling lives in
 * the record rather than in the URL builder: `engine`, `query`, `key` and `count` are the
 * four a search ever sets, and a provider that spells one differently says so here.
 */
export const SEARCH_PROVIDERS = Object.freeze({
  duckduckgo: Object.freeze({
    name: 'duckduckgo',
    label: 'DuckDuckGo',
    endpoint: 'https://www.searchapi.io/api/v1/search',
    params: Object.freeze({ engine: 'duckduckgo', query: 'q', key: 'api_key', count: 'num' }),
    resultsPath: 'organic_results',
    requiresKey: true,
    keyEnv: SEARCH_API_KEY_ENV,
  }),
});

/** A search that failed before any result could be handed over. */
export class WebSearchError extends Error {
  constructor(code, message, guidance = '') {
    super(message);
    this.name = 'WebSearchError';
    this.code = code;
    this.guidance = guidance;
  }
}

/** A positive integer from a caller, or the fallback. */
function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** A caller's count, clamped to `[1, cap]`. */
function clampInt(value, fallback, cap) {
  return Math.min(positiveInt(value, fallback), cap);
}

/**
 * Validate a query and return it trimmed.
 *
 * The refusal names what is wrong and how to fix it, because the model reads it: an empty
 * query is the mistake a caller actually makes, and `INVALID_QUERY` says so rather than
 * sending a request that would come back with nothing.
 */
export function validateQuery(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') {
    throw new WebSearchError(
      'INVALID_QUERY',
      'A non-empty query is required.',
      'Pass the words to search for, e.g. "node.js fetch timeout".',
    );
  }
  return text;
}

/**
 * The provider a name refers to, or the default when none is named.
 *
 * An unknown name is refused rather than silently falling back: a caller that asked for a
 * provider it did not get would read the answer as that provider's.
 */
export function resolveProvider(name = null) {
  const key = String(name ?? '').trim().toLowerCase() || DEFAULT_SEARCH_PROVIDER;
  const provider = SEARCH_PROVIDERS[key];
  if (!provider) {
    throw new WebSearchError(
      'UNKNOWN_PROVIDER',
      `"${key}" is not a search provider this build knows.`,
      `Use one of: ${Object.keys(SEARCH_PROVIDERS).join(', ')}.`,
    );
  }
  return provider;
}

/** The endpoint a provider is asked at, honouring `WEB_SEARCH_ENDPOINT` when set. */
export function providerEndpoint(provider, env = process.env) {
  const override = String(env?.[SEARCH_ENDPOINT_ENV] ?? '').trim();
  return override || provider.endpoint;
}

/** The key a provider's request carries, or `null` when the user configured none. */
export function searchApiKey(provider, env = process.env) {
  if (!provider?.requiresKey) return null;
  const raw = String(env?.[provider.keyEnv ?? SEARCH_API_KEY_ENV] ?? '').trim();
  return raw === '' ? null : raw;
}

/**
 * Build the GET URL for one search.
 *
 * The query, the engine, the key and the count are the only parameters set, and each one
 * is spelled by the provider's own `params` record — so a provider that calls its query
 * `query` instead of `q` is a data change, not a code change.
 */
export function buildSearchUrl(provider, query, {
  apiKey = null,
  maxResults = DEFAULT_SEARCH_RESULTS,
  endpoint = null,
} = {}) {
  const text = validateQuery(query);
  const url = new URL(endpoint || provider.endpoint);
  const params = provider.params ?? {};
  if (params.engine) url.searchParams.set('engine', params.engine);
  url.searchParams.set(params.query ?? 'q', text);
  if (apiKey) url.searchParams.set(params.key ?? 'api_key', apiKey);
  const count = clampInt(maxResults, DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
  if (params.count) url.searchParams.set(params.count, String(count));
  return url.toString();
}

/**
 * Normalise a provider's answer into the one result shape the tool renders:
 * `{ position, title, url, snippet }`.
 *
 * The parse is defensive on purpose. A search API is a third party whose field names drift,
 * and a result list that silently came back empty because one key was renamed is worse than
 * one that kept the fields it could read — so a missing `link` falls back to `url`, a
 * missing `snippet` to `description`, and an entry with neither a title nor a URL is
 * dropped rather than rendered as a blank line.
 */
export function parseSearchResults(payload, { resultsPath = 'organic_results' } = {}) {
  const raw = Array.isArray(payload?.[resultsPath]) ? payload[resultsPath]
    : Array.isArray(payload?.results) ? payload.results
      : [];
  return raw
    .map((item, index) => ({
      position: Number.isInteger(item?.position) ? item.position : index + 1,
      title: String(item?.title ?? '').trim(),
      url: String(item?.link ?? item?.url ?? '').trim(),
      snippet: String(item?.snippet ?? item?.description ?? '').trim(),
    }))
    .filter((result) => result.title !== '' || result.url !== '');
}

/**
 * Lay a result list out as the text a caller reads: one numbered block per result, the
 * title, the URL and the snippet on their own lines. A URL on its own line is what makes
 * the payload greppable and what a `web_fetch` call can be composed from.
 */
export function formatResults(results = []) {
  return (Array.isArray(results) ? results : [])
    .map((result, index) => {
      const lines = [`${result.position ?? index + 1}. ${result.title || '(untitled)'}`];
      if (result.url) lines.push(`   ${result.url}`);
      if (result.snippet) lines.push(`   ${result.snippet}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/** The message a provider's own error field carries, or `null`. */
export function providerError(payload) {
  const error = payload?.error;
  if (typeof error === 'string' && error.trim() !== '') return error.trim();
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message.trim();
  return null;
}

/**
 * Lay out a search as a command document: the header, `---`, and the result list.
 *
 * The counts answer both questions a caller must be able to ask — *how many results came
 * back* (`results`) and *how many am I reading* (`shown`, `truncated`, `mode`) — because a
 * long list and a short one are different facts and neither may be inferred from the other.
 */
export function renderSearchDocument({
  query,
  provider,
  results = 0,
  text = '',
  shown = 0,
  truncated = false,
  mode = 'all',
  capture = null,
  range = null,
  note = null,
} = {}) {
  const header = renderYamlHeader({
    status: 'success',
    query,
    provider,
    results,
    shown,
    truncated,
    mode,
    capture,
    range,
    hint: capture ? CAPTURE_HINT : null,
    note,
  });
  const body = String(text ?? '') === '' ? EMPTY_OUTPUT : String(text);
  return `${header}\n${OUTPUT_DELIMITER}\n${body}`;
}

/**
 * A search that failed, as the JSON envelope the harness uses for every failure: a stable
 * `code`, the query, and the guidance that says what to do instead. A transport failure and
 * a missing key are errors; a provider that answered with zero results is not, because the
 * request worked and "nothing matched" is the news.
 */
export function searchErrorDocument(error, { query = null, provider = null, timeoutMs = null } = {}) {
  const code = error?.code || 'SEARCH_FAILED';
  const message = code === 'TIMEOUT' || error?.name === 'TimeoutError'
    ? `The search timed out after ${timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS}ms.`
    : String(error?.message ?? 'the search failed');
  return JSON.stringify({
    status: 'error',
    code: code === 'TimeoutError' ? 'TIMEOUT' : code,
    query,
    provider,
    message,
    guidance: error?.guidance
      || 'Check the query, or retry with a larger timeoutMs.',
  }, null, 2);
}

export { windowBody, shownRange };
