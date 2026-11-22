/**
 * The streaming half of the provider call: SSE lines, read without losing a character.
 *
 * A streaming response arrives as **bytes**, not as lines. One `reader.read()` returns
 * whatever the transport had buffered, which routinely cuts a JSON payload in half: the
 * first read ends mid-object, the second begins with the tail. Splitting each read on
 * `\n` and parsing the pieces therefore throws away the incomplete line — and the tail of
 * the next read fails to parse on its own — so the deltas inside those two fragments are
 * silently dropped. That is the reported bug: "the response prose is missing space
 * characters … usually at the end of the prose". A space is a delta like any other, and a
 * delta split across a read boundary is a delta lost.
 *
 * The fix is one rule: **the partial line is kept between reads.** A splitter owns the
 * remainder, appends the next read to it, and only ever hands out lines that really ended.
 * A final `flush()` releases the last line of a response that did not end with a newline —
 * without it, a stream whose last delta has no trailing `\n` loses that delta too.
 *
 * This module is pure: no network, no clock, no log. `readStream()` takes the reader the
 * provider already has, so the whole path is provable with a fake reader that splits at
 * the worst possible byte — which is exactly how the bug is tested.
 */

/** The prefix an SSE data line carries. */
const DATA_PREFIX = 'data:';

/** The end-of-stream markers both dialects use. */
const DONE_MARKERS = new Set(['[DONE]', 'data: [DONE]']);

/**
 * A line splitter that keeps the partial line between reads.
 *
 * `push(text)` returns the lines that **ended** in this text and keeps the remainder.
 * `flush()` returns the remainder as a final line and clears it. Neither ever returns an
 * empty trailing line for a well-formed newline, so a caller does not have to filter.
 *
 * @returns {{push: (text: string) => string[], flush: () => string[], pending: () => string}}
 */
export function createLineSplitter() {
  let rest = '';

  return {
    push(text) {
      const combined = rest + String(text ?? '');
      const parts = combined.split('\n');
      // The last part is whatever did not end: it is the next read's problem.
      rest = parts.pop() ?? '';
      return parts;
    },
    flush() {
      const last = rest;
      rest = '';
      return last === '' ? [] : [last];
    },
    pending() {
      return rest;
    },
  };
}

/**
 * What one SSE line says, or `null` when it says nothing this layer cares about.
 *
 * A keep-alive, an SSE comment, a framing line and a payload that is not JSON all answer
 * `null`: a streaming response carries all of them, and none of them is a failure.
 *
 * @param {string} rawLine one complete line
 * @returns {{done: boolean, content: string, thinking: string} | null}
 */
export function parseStreamLine(rawLine) {
  const line = String(rawLine ?? '').trim();
  if (!line) return null;
  if (DONE_MARKERS.has(line)) return { done: true, content: '', thinking: '' };

  const payload = line.startsWith(DATA_PREFIX) ? line.slice(DATA_PREFIX.length).trim() : line;
  if (!payload) return null;

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // A keep-alive or a framing line: not an error, just not a delta.
    return null;
  }

  const message = parsed?.message || parsed?.choices?.[0]?.delta || {};
  // `thinking` is a **flag** in this dialect, not text: a delta marked with it carries
  // reasoning in its `content`, and reasoning is not prose. So the same bytes go to one
  // side or the other, never to both.
  const isThinking = Boolean(message.thinking || (parsed?.message && parsed.message.thinking));
  const text = String(message.content || '');
  return {
    done: Boolean(parsed?.done),
    content: isThinking ? '' : text,
    thinking: isThinking ? text : '',
  };
}

/**
 * Read a streaming response to its end, without losing a delta.
 *
 * The reader is the web `ReadableStreamDefaultReader` the provider already holds; the
 * callbacks are the only side effects. The return value is the whole assistant text, built
 * from the same deltas the callbacks saw — so "what the user was shown" and "what the
 * model said" cannot drift.
 *
 * @param {object} reader a `{ read(): Promise<{done, value}> }` reader
 * @param {object} [options]
 * @param {(text: string) => void} [options.onContent] called per content delta
 * @param {(text: string) => void} [options.onThinking] called per thinking delta
 * @param {() => void} [options.onDone] called when the stream reports it finished
 * @returns {Promise<string>} the full content
 */
export async function readStream(reader, { onContent, onThinking, onDone } = {}) {
  const splitter = createLineSplitter();
  const decoder = new TextDecoder();
  let full = '';

  const handle = (line) => {
    const parsed = parseStreamLine(line);
    if (!parsed) return;
    if (parsed.thinking) {
      if (typeof onThinking === 'function') onThinking(parsed.thinking);
    }
    if (parsed.content) {
      full += parsed.content;
      if (typeof onContent === 'function') onContent(parsed.content);
    }
    if (parsed.done && typeof onDone === 'function') onDone();
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // `stream: true` keeps a multi-byte character whole across reads, exactly as the
    // splitter keeps a line whole: both are the same rule applied to a different unit.
    for (const line of splitter.push(decoder.decode(value, { stream: true }))) handle(line);
  }

  // Whatever the transport had buffered when it closed: a last line with no newline.
  for (const line of splitter.push(decoder.decode())) handle(line);
  for (const line of splitter.flush()) handle(line);

  return full;
}
