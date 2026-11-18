/**
 * The pending-message queue as a model, independent of any terminal widget.
 *
 * A turn can take minutes, and the input box is only armed between turns, so a
 * message typed while a request is in flight would otherwise go nowhere. The
 * queue stores it instead: **FIFO**, **verbatim** (the bytes the model receives
 * are the bytes the user typed), visible right above the input box, deletable one
 * row at a time, and drained by the host loop between two turns.
 *
 * Pure: no neo-blessed, no screen, so the order, the deletion, the row formatting
 * and the click geometry are all unit testable without a pty.
 */

/** Longest preview kept for one row, in characters. */
export const QUEUE_PREVIEW_CHARS = 48;

/** Message rows the bar shows before the rest collapse into a `+N more` tail. */
export const QUEUE_MAX_ROWS = 4;

/** The marker carried by every row; clicking the row deletes that message. */
export const QUEUE_DELETE_MARKER = '✕';

/** The tail row shown when more messages are queued than the bar paints. */
export function formatQueueTail(hidden) {
  return `+${Number(hidden) || 0} more`;
}

/**
 * One display-ready line for a queued message: whitespace runs (including the
 * newlines of a pasted block) collapse to single spaces and the result is
 * truncated to `maxChars`, with an ellipsis when something was dropped.
 *
 * Display only — the model keeps the raw text untouched.
 */
export function previewMessage(text, { maxChars = QUEUE_PREVIEW_CHARS } = {}) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const limit = Math.max(1, Math.trunc(Number(maxChars)) || QUEUE_PREVIEW_CHARS);
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * One queue row: the delete marker, the 1-based position, then the preview.
 * Accepts a queue item (`{ id, text }`) or a bare string.
 */
export function formatQueueRow(message, index = 0) {
  const text = message && typeof message === 'object' ? message.text : message;
  const position = Math.trunc(Number(index)) + 1;
  const label = Number.isFinite(position) && position > 0 ? `${position}. ` : '';
  return `${QUEUE_DELETE_MARKER} ${label}${previewMessage(text)}`;
}

/**
 * The rows of the queue bar, top to bottom: one `✕` row per message, in queue
 * order, and — when more than `maxRows` are waiting — a final `+N more` tail
 * naming how many rows are not painted.
 */
export function formatQueueRows(messages = [], { maxRows = QUEUE_MAX_ROWS } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const cap = Math.max(0, Math.trunc(Number(maxRows)) || 0);
  const shown = Math.min(list.length, cap);
  const rows = list.slice(0, shown).map((message, index) => formatQueueRow(message, index));
  const hidden = list.length - shown;
  if (hidden > 0) rows.push(formatQueueTail(hidden));
  return rows;
}

/**
 * Map a click on the queue region to the index of the message under the cursor:
 * `data.y` is a screen row, `pos` the widget's painted coordinates, `itop` the
 * border plus padding above the content and `offset` the first painted row.
 *
 * Rows are painted in queue order, so row `i` is message `i`; a click outside the
 * region, below the painted messages or on the `+N more` tail yields -1 (nothing
 * to delete). `rtof` is blessed's fake->real map: a row a preview wrapped onto is
 * mapped back to the message it belongs to, so a wrap cannot delete its
 * neighbour. Pure and defensive: a missing widget or click yields -1 too.
 */
export function queueRowAt({ data, pos, messages = [], itop = 0, offset = 0, rtof = null } = {}) {
  if (!pos || !data) return -1;
  const row = Number(data.y) - Number(pos.yi) - (Number(itop) || 0);
  if (!Number.isFinite(row) || row < 0) return -1;
  const painted = Math.max(0, Math.trunc(Number(offset)) || 0) + row;
  const real = Array.isArray(rtof) && painted < rtof.length ? Number(rtof[painted]) : painted;
  if (!Number.isFinite(real) || real < 0) return -1;
  const index = Math.trunc(real);
  const list = Array.isArray(messages) ? messages : [];
  return index < list.length ? index : -1;
}

/**
 * The prompt of the next turn: the oldest queued message when one is waiting,
 * otherwise the front end's own question. This is the *injection point* of
 * task.md — the host loop calls it between two turns and never inside a tool
 * chain, so an injected message can never split an assistant `tool_calls` message
 * from its `tool` results.
 *
 * Pure and async, so the drain rule is unit tested without a pty or a loop.
 *
 * @param {object} options
 * @param {Function|null} [options.dequeue] the queue's drain (null without one)
 * @param {Function} options.ask            the front end's question()
 */
export async function nextPrompt({ dequeue = null, ask = null } = {}) {
  const queued = typeof dequeue === 'function' ? dequeue() : null;
  if (queued != null) return queued;
  return typeof ask === 'function' ? ask() : null;
}

/**
 * The queue itself: an ordered list of messages plus its subscribers.
 *
 * Every mutation (enqueue, dequeue, remove, clear) notifies the subscribers with
 * a copy of the current items, so the widget repaints from one place and the
 * copy can never be mutated by a listener.
 */
export function createMessageQueue() {
  let items = [];
  let nextId = 1;
  const listeners = new Set();

  const snapshot = () => items.map((item) => ({ ...item }));

  const notify = () => {
    const copy = snapshot();
    for (const listener of [...listeners]) listener(copy);
  };

  /**
   * Queue one message verbatim. An empty or blank message is not queued — there
   * would be nothing to inject — and yields null; anything else is stored as
   * typed, without trimming.
   */
  const enqueue = (text) => {
    const raw = String(text ?? '');
    if (!raw.trim()) return null;
    const item = { id: `msg-${nextId++}`, text: raw };
    items = [...items, item];
    notify();
    return { ...item };
  };

  /** Take the oldest message out (FIFO); null when the queue is empty. */
  const dequeue = () => {
    if (!items.length) return null;
    const [first, ...rest] = items;
    items = rest;
    notify();
    return { ...first };
  };

  /** Drop one message by id; returns it, or null when the id is unknown. */
  const remove = (id) => {
    const found = items.find((item) => item.id === id);
    if (!found) return null;
    items = items.filter((item) => item !== found);
    notify();
    return { ...found };
  };

  /** Drop every message; returns how many were removed. */
  const clear = () => {
    const removed = items.length;
    if (!removed) return 0;
    items = [];
    notify();
    return removed;
  };

  return {
    enqueue,
    dequeue,
    remove,
    clear,
    /** The oldest message without removing it, or null. */
    peek: () => (items.length ? { ...items[0] } : null),
    /**
     * Observe every change: `listener(items)` receives a copy, the newest queue
     * first. Returns the unsubscribe function.
     */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get items() {
      return snapshot();
    },
    get size() {
      return items.length;
    },
    get isEmpty() {
      return items.length === 0;
    },
  };
}
