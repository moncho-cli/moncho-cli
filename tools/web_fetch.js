import { defineTool } from '../utils/tool-schema.js';
import { putCapture } from '../utils/capture-store.js';
import { htmlToText } from '../utils/html-text.js';
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_FETCH_LINES,
  MAX_FETCH_TIMEOUT_MS,
  MAX_MAX_BODY_BYTES,
  MAX_FETCH_LINES,
  WebFetchError,
  validateFetchUrl,
  fetchUrl,
  readBounded,
  decodeBody,
  renderFetchDocument,
  windowBody,
  shownRange,
  fetchErrorDocument,
  isHtmlType,
} from '../utils/web-fetch.js';

/**
 * `web_fetch` — retrieve a URL (`docs/agent/web-fetch`).
 *
 * The one tool that leaves the project tree, so the whole design is about the door being
 * the *only* door: `utils/web-fetch.js` validates the scheme, bounds the bytes, the
 * redirects and the time, and this file does the one thing a tool should — it answers in
 * the shape the other tools answer in.
 *
 * The result is the **command document** (`utils/command-output.js`): a YAML header
 * saying what was fetched and how much of it is shown, `---`, then the body as text. HTML
 * is reduced by `utils/html-text.js`; anything else (`application/json`, `text/plain`) is
 * passed through as it arrived, because a JSON API's answer is already text.
 *
 * A long body is not lost: the whole thing goes into the capture store and the header
 * carries `capture: <id>`, so the model pages or scans it with `read_capture` — the
 * mechanism `docs/agent/command-capture` already defines. One new tool, no second paging
 * grammar.
 *
 * A refusal before the request and a failure during it both answer the JSON envelope with
 * a stable `code`; a *server* answer, 404 included, is a document, because the request
 * worked and the page's status is the news.
 */

/** The response headers worth carrying into the document: what was served, and when. */
const CARRIED_HEADERS = ['content-type', 'last-modified', 'etag', 'location'];

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

/** The few response headers a document reports, lowercased. */
export function responseHeaders(response) {
  const out = {};
  for (const name of CARRIED_HEADERS) {
    const value = response?.headers?.get?.(name);
    if (value) out[name] = value;
  }
  return out;
}

/**
 * Reduce a fetched body to the text a caller can read: HTML through
 * `utils/html-text.js`, everything else as it was decoded.
 *
 * The declared charset is read from the response's `content-type` and, when that says
 * nothing, from the first bytes of the document itself — which is why the head is decoded
 * here as UTF-8 first: a `<meta charset>` is ASCII in every encoding that carries one.
 */
export function bodyText(bytes, { contentType = '' } = {}) {
  const head = isHtmlType(contentType) ? new TextDecoder('utf-8').decode(bytes.slice(0, 2048)) : '';
  const decoded = decodeBody(bytes, { contentType, head });
  if (!isHtmlType(contentType)) return { ...decoded, reduced: false };
  return { ...decoded, text: htmlToText(decoded.text), reduced: true };
}

const { definition, execute } = defineTool({
  name: 'web_fetch',
  description:
    'Retrieve a URL over http(s) with one GET. A success answers the same document as run_bash: a YAML header (url, http_status, content_type, bytes, lines, shown, truncated, capture), a "---" delimiter, then the body as text — HTML reduced to readable text, JSON and plain text passed through. The body is bounded (default 256 KiB) and its first 200 lines are shown, with the whole text behind a `capture:` handle for read_capture. A bad URL, an unsupported scheme, a timeout or a redirect loop answers a JSON error with a stable code; an HTTP status like 404 is a document, because the server answered. Read-only: it may fetch, and it cannot write, post or upload anything.',
  parameters: {
    properties: {
      url: {
        type: 'string',
        description: 'The absolute URL to retrieve, scheme included: "https://example.com/page". Only http and https can be fetched.',
      },
      timeoutMs: {
        type: 'integer',
        description: `Whole-request timeout in milliseconds (default ${DEFAULT_FETCH_TIMEOUT_MS}, at most ${MAX_FETCH_TIMEOUT_MS}).`,
      },
      maxBytes: {
        type: 'integer',
        description: `How much of the body is read, in bytes (default ${DEFAULT_MAX_BODY_BYTES}, at most ${MAX_MAX_BODY_BYTES}). The rest is not downloaded and the header says truncated: true.`,
      },
      maxRedirects: {
        type: 'integer',
        description: `How many redirect hops may be followed (default ${DEFAULT_MAX_REDIRECTS}). More than that is a loop and answers TOO_MANY_REDIRECTS.`,
      },
      maxLines: {
        type: 'integer',
        description: `How many lines of the body text the document shows (default ${DEFAULT_FETCH_LINES}, at most ${MAX_FETCH_LINES}). The rest is behind the capture handle.`,
      },
    },
    required: ['url'],
  },
  async execute(args) {
    const rawUrl = String(args.url ?? '').trim();
    try {
      validateFetchUrl(rawUrl);
    } catch (error) {
      return failure(error.code, error.message, error.guidance, { url: rawUrl });
    }

    const timeoutMs = Number.isInteger(args.timeoutMs) && args.timeoutMs > 0
      ? Math.min(args.timeoutMs, MAX_FETCH_TIMEOUT_MS)
      : DEFAULT_FETCH_TIMEOUT_MS;

    let fetched;
    try {
      fetched = await fetchUrl(rawUrl, {
        timeoutMs,
        maxRedirects: Number.isInteger(args.maxRedirects) ? args.maxRedirects : DEFAULT_MAX_REDIRECTS,
      });
    } catch (error) {
      if (error instanceof WebFetchError) {
        return failure(error.code, error.message, error.guidance, { url: rawUrl });
      }
      // A transport failure: DNS, a refused connection, a timeout, a cut socket.
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      if (timeout) {
        return failure('TIMEOUT', `The request timed out after ${timeoutMs}ms.`, 'Retry with a larger timeoutMs, or fetch a different URL.', { url: rawUrl });
      }
      return failure(
        'FETCH_FAILED',
        `The request to ${rawUrl} failed: ${error?.message ?? 'unknown error'}.`,
        'Check the URL and that the host is reachable from here.',
        { url: rawUrl },
      );
    }

    const { response, finalUrl } = fetched;
    const headers = responseHeaders(response);
    const contentType = headers['content-type'] || '';

    let bounded;
    try {
      bounded = await readBounded(response, Number.isInteger(args.maxBytes) && args.maxBytes > 0
        ? Math.min(args.maxBytes, MAX_MAX_BODY_BYTES)
        : DEFAULT_MAX_BODY_BYTES);
    } catch (error) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      return failure(
        timeout ? 'TIMEOUT' : 'FETCH_FAILED',
        timeout ? `The body did not finish within ${timeoutMs}ms.` : `Reading the body failed: ${error?.message ?? 'unknown error'}.`,
        timeout ? 'Retry with a larger timeoutMs, or fetch a smaller resource.' : 'Retry the fetch; the connection was cut mid-body.',
        { url: finalUrl },
      );
    }

    const decoded = bodyText(bounded.bytes, { contentType });
    const window = windowBody(decoded.text, Number.isInteger(args.maxLines) && args.maxLines > 0 ? args.maxLines : DEFAULT_FETCH_LINES);
    // A body is worth keeping in the capture store when either bound cut it: the window
    // (more lines than `maxLines`) **or the download** (more bytes than `maxBytes`). The
    // second case is the subtle one — a cut body can be a single long line, so nothing was
    // windowed and `mode` is `all`, yet the rest of the page is exactly what a caller may
    // still need. Writing the capture on the window alone would lose it.
    const capture = window.truncated || bounded.truncated
      ? putCapture({ command: `web_fetch ${finalUrl}`, text: decoded.text })
      : null;

    return renderFetchDocument({
      url: rawUrl,
      finalUrl,
      httpStatus: response.status,
      contentType,
      charset: decoded.charset,
      bytes: bounded.bytes.length,
      totalBytes: bounded.totalBytes,
      downloadTruncated: bounded.truncated,
      text: window.text,
      lines: window.total,
      shown: window.shown,
      textTruncated: window.truncated,
      mode: window.mode,
      capture: capture ? capture.id : null,
      range: capture ? shownRange(window) : null,
      note: decoded.note,
    });
  },
});

export { definition, execute, fetchErrorDocument };