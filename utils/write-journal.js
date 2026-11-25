/**
 * The before/after pair of a file write, held for the screen and never for the model.
 *
 * A diff has to be computed from bytes that exist *inside* the writer — the old text
 * a `write_file` overwrote, the `original` an `edit_file` applied against — and there
 * is exactly one place those bytes must not go: the value the tool returns.
 * `utils/tool-loader.js` hands that value to the model and it is re-sent on every
 * following call of the session, so a diff riding on it would be billed for the rest
 * of the conversation to draw one block on the screen (backlog item 53).
 *
 * So this is a **host registry**, the same shape as `utils/host.js` and
 * `utils/read-tracker.js`: a write records its pair, the echo
 * (`app/tool-echo.js`) takes it and builds the block, and nothing is persisted. A
 * resumed session therefore shows no diffs for writes made before it, which is the
 * safe direction — a diff is a view, and the view of a past write is in
 * `agent/logs` and the tool result, not here.
 *
 * Three rules keep the registry from becoming a memory leak or a lie:
 *
 *  - **one entry per path.** A file written twice in a turn shows the second diff, not
 *    a queue of stale ones; the entry is keyed by the resolved path so a write through
 *    a different spelling of the same file does not shadow it.
 *  - **the pair is dropped once taken** (`take`), because the block is built once and a
 *    second draw of the same edit would be a diff the reader has already seen.
 *  - **a huge file is not held.** Above `DIFF_CAPTURE_MAX_CHARS` the pair is recorded
 *    as a count instead of the bytes, because a 10 MB file would otherwise sit in
 *    memory twice over to draw a block nobody scrolls through.
 */

/** The largest pair, in characters, that is held for a diff. */
export const DIFF_CAPTURE_MAX_CHARS = 2_000_000;

/** Path → capture, for the writes not yet drawn. */
const captures = new Map();

/**
 * Normalise the key a capture is filed under.
 *
 * `resolveProjectPath` is deliberately *not* called here: this module is imported by
 * writers that have already resolved and sandboxed their path, and a second
 * resolution would make a refusal in the resolver look like a capture failure. The
 * path the writer used is the path the echo will look for, so it is used verbatim.
 *
 * @param {string} path
 * @returns {string}
 */
export function captureKey(path) {
  return typeof path === 'string' ? path : '';
}

/**
 * Record the bytes around a write.
 *
 * @param {object} options
 * @param {string} options.path the path as the writer named it
 * @param {?string} [options.before] the text before the write, `null` for a creation
 * @param {?string} [options.after] the text after the write
 * @param {boolean} [options.created] whether the file did not exist before
 * @returns {boolean} whether a capture was recorded
 */
export function recordWriteCapture({ path, before = null, after = null, created = false } = {}) {
  const key = captureKey(path);
  if (!key) return false;

  const beforeText = typeof before === 'string' ? before : null;
  const afterText = typeof after === 'string' ? after : null;
  const oversize = (beforeText?.length ?? 0) + (afterText?.length ?? 0) > DIFF_CAPTURE_MAX_CHARS;
  captures.set(key, {
    path: key,
    // An oversize pair keeps the shape of the capture — so the echo knows a write
    // happened and can say so — while dropping the bytes it must not hold.
    before: oversize ? null : beforeText,
    after: oversize ? null : afterText,
    created: Boolean(created),
    oversize,
  });
  return true;
}

/**
 * Take the capture for a path, dropping it from the registry.
 *
 * @param {string} path
 * @returns {?object} the capture, or `null` when the write was never recorded
 */
export function takeWriteCapture(path) {
  const key = captureKey(path);
  if (!key || !captures.has(key)) return null;
  const capture = captures.get(key);
  captures.delete(key);
  return capture;
}

/**
 * Read a capture without consuming it (the tests, and a caller that paints twice).
 *
 * @param {string} path
 * @returns {?object}
 */
export function peekWriteCapture(path) {
  const key = captureKey(path);
  return key && captures.has(key) ? captures.get(key) : null;
}

/** How many captures are pending — a leak this small is worth being able to assert. */
export function pendingCaptureCount() {
  return captures.size;
}

/** Drop every pending capture (teardown, and the suite's own isolation). */
export function clearWriteCaptures() {
  captures.clear();
}