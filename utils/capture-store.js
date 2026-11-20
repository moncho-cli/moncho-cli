/**
 * The in-memory store of captured command output (`docs/agent/command-capture`).
 *
 * A command's full output is a resource the model may need to *scan*, not a string to
 * flood the context with. When a capture is too long to hand over whole, the command
 * document carries a handle (`capture: 2`) and the bytes stay here, addressed by that
 * handle, until the turn moves on.
 *
 * Three properties are deliberate:
 *
 *  - **nothing touches disk.** Command output is attacker-influenced text, so a capture
 *    is only ever a string in this `Map` — never a file a later command could run.
 *  - **a capture is short-lived.** `expireCaptures()` is called when a tool batch is
 *    dispatched that does not read a capture, so inspection has to be the model's next
 *    action. That bounds the lifetime, which is what makes holding the bytes safe.
 *  - **the store is bounded.** A handful of captures at most, plus a total byte cap; the
 *    oldest is dropped first, so a long session cannot grow without limit.
 *
 * Pure bookkeeping — no `fs`, no child process, no terminal — so the whole rule is unit
 * tested on plain strings.
 */

/** How many captures are retained at once. */
export const DEFAULT_MAX_CAPTURES = 4;

/** The total bytes the store may hold before the oldest captures are dropped. */
export const DEFAULT_MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

/** The captures the model has not inspected yet: handle -> `{ id, command, text, bytes, lines, at }`. */
const captures = new Map();

/**
 * Handles are **monotonic and never reused**: a stale `capture: 2` in an old transcript
 * must fail (`CAPTURE_EXPIRED`) rather than silently address a newer capture.
 */
let nextId = 1;

/** The number of lines in a text, with a single trailing newline ignored. */
export function countCaptureLines(text) {
  const raw = String(text ?? '');
  if (raw === '') return 0;
  return (raw.endsWith('\n') ? raw.slice(0, -1) : raw).split('\n').length;
}

/** A usable handle: a positive integer, or `null`. */
export function normalizeCaptureId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Drop the oldest captures until the store fits both caps. Returns the dropped ids. */
export function evictCaptures({
  maxCaptures = DEFAULT_MAX_CAPTURES,
  maxBytes = DEFAULT_MAX_CAPTURE_BYTES
} = {}) {
  const dropped = [];
  const overCount = () => captures.size > Math.max(1, maxCaptures);
  const totalBytes = () => [...captures.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  const overBytes = () => totalBytes() > Math.max(1, maxBytes);

  while (captures.size > 0 && (overCount() || overBytes())) {
    const oldest = captures.keys().next().value;
    captures.delete(oldest);
    dropped.push(oldest);
  }
  return dropped;
}

/**
 * Store one captured output and return its entry, whose `id` is the handle the model is
 * given. Eviction happens here, so a caller can never leave the store oversized.
 *
 * @param {{command?: string, text?: string, at?: number}} [capture]
 * @param {{maxCaptures?: number, maxBytes?: number}} [limits]
 */
export function putCapture({ command = '', text = '', at = Date.now() } = {}, limits = {}) {
  const body = String(text ?? '');
  const entry = {
    id: nextId++,
    command: String(command ?? ''),
    text: body,
    bytes: body.length,
    lines: countCaptureLines(body),
    at
  };
  captures.set(entry.id, entry);
  evictCaptures(limits);
  // The entry just stored is the newest, so eviction can never have taken it.
  return entry;
}

/** The entry behind a handle, or `null` when it never existed or has expired. */
export function getCapture(id) {
  const key = normalizeCaptureId(id);
  return key === null ? null : captures.get(key) || null;
}

/** True when the handle still resolves. */
export function hasCapture(id) {
  return getCapture(id) !== null;
}

/** Forget one capture. Returns whether it was there. */
export function dropCapture(id) {
  const key = normalizeCaptureId(id);
  return key === null ? false : captures.delete(key);
}

/**
 * Keep only the named handles and drop every other capture — the expiry that runs when
 * the model moves on to something other than reading a capture.
 *
 * @param {{keep?: Array<number|string>}} [options]
 * @returns {number[]} the handles that were dropped
 */
export function expireCaptures({ keep = [] } = {}) {
  const kept = new Set(keep.map(normalizeCaptureId).filter((id) => id !== null));
  const dropped = [];
  for (const id of [...captures.keys()]) {
    if (kept.has(id)) continue;
    captures.delete(id);
    dropped.push(id);
  }
  return dropped;
}

/** Drop every capture. Handles stay monotonic, so an old one is never re-issued. */
export function clearCaptures() {
  captures.clear();
}

/** The live handles, oldest first. */
export function captureIds() {
  return [...captures.keys()];
}

/** What the store currently holds (diagnostics and tests). */
export function captureStats() {
  return {
    count: captures.size,
    bytes: [...captures.values()].reduce((sum, entry) => sum + entry.bytes, 0),
    ids: captureIds()
  };
}

/**
 * The capture handles a batch of tool calls asked to read.
 *
 * This is the input that decides what survives a batch (`app/tool-batch.js#handleToolBatch`):
 * a call whose arguments could not be parsed reads nothing, so it keeps nothing alive.
 */
export function capturesRequestedBy(calls = []) {
  return (Array.isArray(calls) ? calls : [])
    .filter((call) => call?.name === 'read_capture' && call.args && typeof call.args === 'object')
    .map((call) => call.args.capture)
    .filter((id) => id !== undefined && id !== null);
}
