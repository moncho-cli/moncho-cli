import { windowLines, renderYamlHeader, OUTPUT_DELIMITER, EMPTY_OUTPUT, CAPTURE_HINT } from './command-output.js';
import { htmlToText, isHtmlType } from './html-text.js';
import { USER_AGENT } from '../config/constants.js';

/**
 * Retrieving a URL, bounded in every direction it can grow (`docs/agent/web-fetch`).
 *
 * `web_fetch` is the one tool that reaches outside the project tree, so this module is
 * where "outside" is made answerable and finite. Four bounds, each one a decision:
 *
 *  - **the scheme.** `http` and `https` only. `file:`, `data:` and friends are a different
 *    capability wearing a URL's clothes, and the agent already reads local files with the
 *    tools that are allowed to.
 *  - **the size.** The body is read **streaming** and cut at `maxBytes`, so a hostile or
 *    merely huge response costs a bounded amount of memory and of context before anything
 *    else happens. A cut body is reported as `truncated: true`, never silently shortened.
 *  - **the redirects.** At most `DEFAULT_MAX_REDIRECTS` hops, followed manually so `https`
 *    can never be downgraded to `http` mid-flight, and so a redirect loop is an error
 *    rather than a hang.
 *  - **the time.** One `AbortSignal.timeout` for the whole exchange — a host that accepts a
 *    connection and never answers is exactly the case a timeout exists for.
 *
 * What comes back is the **command document** (`utils/command-output.js`): a YAML header,
 * `---`, and the payload. The payload is the body reduced to text when it is HTML
 * (`utils/html-text.js`), and windowed to its first lines, with the whole body left in the
 * capture store for `read_capture` — so a long page is scannable with `pattern` instead of
 * arriving whole.
 *
 * Nothing here touches disk or a terminal, and the request is always a **GET**: a fetch
 * reads a resource, and a body-carrying method would be a write aimed at a stranger.
 */

/** How long one fetch may take, unless the caller asks for something else. */
export const DEFAULT_FETCH_TIMEOUT_MS = 30000;
export const MAX_FETCH_TIMEOUT_MS = 300000;

/** How much of a body is read, unless the caller asks for something else. */
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
export const MAX_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Redirect hops followed before the chain is called a loop. */
export const DEFAULT_MAX_REDIRECTS = 5;

/** How many lines of the body text the document shows, and the ceiling on that. */
export const DEFAULT_FETCH_LINES = 200;
export const MAX_FETCH_LINES = 1000;

/** The only schemes a fetch may use. */
export const ALLOWED_PROTOCOLS = Object.freeze(['http:', 'https:']);

/** The `User-Agent` a fetch presents when the user configured none. */
export const FETCH_USER_AGENT_DEFAULT = 'moncho-cli';

/**
 * The headers one fetch carries: an `accept` list and a `User-Agent`.
 *
 * The user agent is configurable through `MONCHO_USER_AGENT`
 * (`config/constants.js#USER_AGENT`) — the same knob a provider call reads, so one
 * setting names the program to the provider and to every host it fetches from. When the
 * user configured none, `FETCH_USER_AGENT_DEFAULT` is presented, because a client that
 * names itself nothing is refused by a fair number of hosts. The `accept` list stays
 * fixed: the user's key, the conversation and every local path stay out of the request.
 */
export function fetchHeaders(userAgent = USER_AGENT) {
  const raw = String(userAgent ?? '').trim();
  return {
    accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
    'user-agent': raw || FETCH_USER_AGENT_DEFAULT,
  };
}

/** A fetch that failed before any body could be handed over. */
export class WebFetchError extends Error {
  constructor(code, message, guidance = '') {
    super(message);
    this.name = 'WebFetchError';
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
 * Validate a URL and return it as a `URL`.
 *
 * The refusal names what is wrong and how to fix it, because the model reads it: a bare
 * host is the mistake a caller actually makes, and `INVALID_URL` says so rather than
 * handing back a DNS failure.
 */
export function validateFetchUrl(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') {
    throw new WebFetchError('INVALID_URL', 'A non-empty url is required.', 'Pass an absolute http(s) URL, e.g. "https://example.com/page".');
  }

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new WebFetchError(
      'INVALID_URL',
      `"${text}" is not an absolute URL.`,
      'Include the scheme: "https://example.com/page", not "example.com/page".',
    );
  }

  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    throw new WebFetchError(
      'UNSUPPORTED_PROTOCOL',
      `The scheme "${parsed.protocol}" cannot be fetched; only http and https can.`,
      'Use an http(s) URL: another scheme is a different capability, not a fetch.',
    );
  }
  if (!parsed.hostname) {
    throw new WebFetchError('INVALID_URL', `"${text}" names no host.`, 'Name the host: "https://example.com".');
  }
  return parsed;
}

/** The `charset` a content type names, lowercased, or `null`. */
export function charsetFromContentType(contentType) {
  const match = String(contentType ?? '').match(/charset\s*=\s*"?([\w-]+)"?/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * The `charset` a document declares about itself, from the first bytes of its head —
 * a `<meta charset>`, or the older `<meta http-equiv>` spelling. The content type wins
 * when it carries one; this is the fallback for the many pages that only say it in markup.
 */
export function charsetFromBody(head) {
  const text = String(head ?? '');
  const direct = text.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i);
  if (direct) return direct[1].toLowerCase();
  const equiv = text.match(/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i);
  return equiv ? equiv[1].toLowerCase() : null;
}

/** Normalise a charset label to a spelling this runtime accepts, or `null`. */
export function normalizeCharset(label) {
  const name = String(label ?? '').trim().toLowerCase();
  if (name === '') return null;
  if (name === 'utf8' || name === 'utf-8' || name === 'unicode-1-1-utf-8') return 'utf-8';
  if (name === 'latin1' || name === 'latin-1' || name === 'iso8859-1' || name === 'iso-8859-1' || name === 'windows-1252' || name === 'cp1252') {
    return 'windows-1252';
  }
  return name;
}

/** True when a charset name is one this runtime can decode with. */
export function isSupportedCharset(name) {
  try {
    new TextDecoder(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode a body's bytes: the charset the response declares, else the one the document
 * declares, else UTF-8. An unknown label falls back with a note rather than throwing —
 * mangled text beats no text.
 *
 * @returns {{text: string, charset: string, note: string|null}}
 */
export function decodeBody(bytes, { contentType = '', head = null } = {}) {
  const declared = normalizeCharset(charsetFromContentType(contentType))
    || normalizeCharset(head === null ? null : charsetFromBody(head))
    || 'utf-8';
  const charset = isSupportedCharset(declared) ? declared : 'utf-8';
  const note = charset === declared ? null : `the declared charset "${declared}" is unknown here; decoded as utf-8`;
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  return { text: new TextDecoder(charset).decode(data), charset, note };
}

/**
 * Read a response body up to `maxBytes`, streaming so the cap is honoured before the whole
 * body exists in memory.
 *
 * @returns {Promise<{bytes: Uint8Array, totalBytes: number, truncated: boolean}>}
 */
export async function readBounded(response, maxBytes) {
  const cap = positiveInt(maxBytes, DEFAULT_MAX_BODY_BYTES);
  const body = response?.body;

  if (!body || typeof body.getReader !== 'function') {
    // No stream to cut: the body is taken whole, then cut. Older runtimes only.
    const whole = new Uint8Array(await response.arrayBuffer());
    return { bytes: whole.slice(0, cap), totalBytes: whole.length, truncated: whole.length > cap };
  }

  const reader = body.getReader();
  const chunks = [];
  let totalBytes = 0;
  let kept = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value ?? new Uint8Array(0);
    totalBytes += chunk.length;
    if (kept < cap) {
      const slice = chunk.length <= cap - kept ? chunk : chunk.slice(0, cap - kept);
      chunks.push(slice);
      kept += slice.length;
      if (kept >= cap) truncated = true;
    } else {
      truncated = true;
    }
    if (truncated) {
      // Stop pulling: the rest is not ours to hold.
      try { await reader.cancel(); } catch { /* the socket is closing anyway */ }
      break;
    }
  }

  const bytes = new Uint8Array(kept);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { bytes, totalBytes, truncated };
}

/** A whole-exchange timeout signal (exported so the rule is testable without a socket). */
export function timeoutSignal(ms) {
  const budget = positiveInt(ms, DEFAULT_FETCH_TIMEOUT_MS);
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(budget);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${budget}ms`)), budget);
  timer.unref?.();
  return controller.signal;
}

/**
 * Perform one GET, following redirects by hand up to `maxRedirects`.
 *
 * `https` is never downgraded: a redirect that would drop the scheme is refused as
 * `REDIRECT_DOWNGRADE`, because "the page moved" is not permission to send the request in
 * the clear.
 *
 * @returns {Promise<{response: Response, finalUrl: string, hops: number}>}
 */
export async function fetchUrl(rawUrl, {
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  signal = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new WebFetchError('FETCH_UNAVAILABLE', 'This runtime has no global fetch().', 'Use run_bash with an approved command, or fetch from a runtime with fetch.');
  }

  const budget = clampInt(timeoutMs, DEFAULT_FETCH_TIMEOUT_MS, MAX_FETCH_TIMEOUT_MS);
  const abort = signal ?? timeoutSignal(budget);
  const hops = Math.max(0, Number.isInteger(maxRedirects) ? maxRedirects : DEFAULT_MAX_REDIRECTS);
  let current = validateFetchUrl(rawUrl);

  for (let hop = 0; hop <= hops; hop += 1) {
    const response = await fetchImpl(current.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: abort,
      headers: fetchHeaders(),
    });

    const location = response.headers?.get?.('location');
    if (response.status >= 300 && response.status < 400 && location) {
      try { await response.body?.cancel(); } catch { /* nothing to drain */ }
      const next = new URL(location, current);
      if (current.protocol === 'https:' && next.protocol !== 'https:') {
        throw new WebFetchError(
          'REDIRECT_DOWNGRADE',
          `${current.toString()} redirected to the insecure ${next.toString()}.`,
          'Fetch the https URL directly, or ask the user before following an insecure redirect.',
        );
      }
      validateFetchUrl(next.toString());
      current = next;
      continue;
    }
    return { response, finalUrl: current.toString(), hops: hop };
  }

  throw new WebFetchError(
    'TOO_MANY_REDIRECTS',
    `More than ${hops} redirects in a row, which is a loop.`,
    'Fetch the final URL the site actually uses.',
  );
}

/** The URL of a redirect chain's last hop, for the document's `final_url`. */
function shortFinalUrl(url, requested) {
  return String(url) === String(requested) ? null : String(url);
}

/**
 * Lay out a fetched body as a command document: the header, `---`, and the text window.
 *
 * The counts in the header answer both questions a caller must be able to ask — *how much
 * did the server send* (`bytes`, `total_bytes`) and *how much of it am I reading*
 * (`lines`, `shown`, `truncated`, `mode`) — because "the page was long" and "the download
 * was cut" are different facts and neither may be inferred from the other.
 */
export function renderFetchDocument({
  url,
  finalUrl = null,
  httpStatus = 0,
  contentType = '',
  charset = null,
  bytes = 0,
  totalBytes = 0,
  downloadTruncated = false,
  text = '',
  lines = 0,
  shown = 0,
  textTruncated = false,
  mode = 'all',
  capture = null,
  range = null,
  note = null,
} = {}) {
  const header = renderYamlHeader({
    status: 'success',
    url,
    final_url: shortFinalUrl(finalUrl ?? url, url),
    http_status: httpStatus,
    content_type: contentType || null,
    charset,
    bytes,
    total_bytes: totalBytes === bytes ? null : totalBytes,
    truncated: downloadTruncated,
    lines,
    shown,
    mode,
    capture,
    range,
    hint: capture ? CAPTURE_HINT : null,
    note,
  });
  return `${header}\n${OUTPUT_DELIMITER}\n${shown > 0 ? String(text) : EMPTY_OUTPUT}`;
}

/**
 * Window body text to its first `maxLines` lines.
 *
 * A page is read from the *top* — its title and its opening are what a caller is after —
 * which is the one place this differs from a command's default tail
 * (`utils/command-output.js#windowCaptured`): a build's verdict is at the end, a
 * document's meaning starts at the beginning.
 */
export function windowBody(text, maxLines) {
  const total = String(text ?? '').split('\n').length;
  const cap = clampInt(maxLines, DEFAULT_FETCH_LINES, MAX_FETCH_LINES);
  if (total <= cap) {
    return { text: String(text ?? ''), total, shown: total, truncated: false, mode: 'all' };
  }
  const window = windowLines(text, { head: cap });
  return { text: window.text, total: window.total, shown: window.shown, truncated: true, mode: 'head' };
}

/** The 1-based line range a head window covers, so the capture can be paged from it. */
export function shownRange(window) {
  const shown = Number(window?.shown) || 0;
  return window?.mode === 'head' && shown > 0 ? `1-${shown}` : null;
}

/**
 * A fetch that failed, as the JSON envelope the harness uses for every failure: a stable
 * `code`, the URL, and the guidance that says what to do instead. A transport failure is
 * an error; a 404 is not, because the server answered.
 */
export function fetchErrorDocument(error, { url = null, timeoutMs = null } = {}) {
  const code = error?.code || 'FETCH_FAILED';
  const message = code === 'TIMEOUT' || error?.name === 'TimeoutError'
    ? `The request timed out after ${timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS}ms.`
    : String(error?.message ?? 'the request failed');
  return JSON.stringify({
    status: 'error',
    code: code === 'TimeoutError' ? 'TIMEOUT' : code,
    url,
    message,
    guidance: error?.guidance
      || 'The host did not answer with a body. Check the URL, or retry with a larger timeoutMs.',
  }, null, 2);
}

export { htmlToText, isHtmlType };
