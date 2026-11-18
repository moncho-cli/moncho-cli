/**
 * The pending-message queue as a model, independent of any terminal widget.
 *
 * A turn can take minutes, and the input box is only armed between turns, so a
 * message typed while a request is in flight would otherwise go nowhere. The
 * queue stores it instead: **FIFO**, **verbatim** (the bytes the model receives
 * are the bytes the user typed), visible right above the input box, deletable one
 * row at a time, and drained by the host loop between two turns.
 *
 * Pure: no neo-blessed, no screen, so the order, the deletion and the click
 * geometry are all unit testable without a pty. How a message is *drawn* — one row
 * fitted to the width the bar really has — lives in `app/queue-rows.js`, which is
 * re-exported here so `app/message-queue.js` stays the queue's single entry point.
 */

/**
 * Map a click on the queue region to the index of the message under the cursor:
 * `data.y` is a screen row, `pos` the widget's painted coordinates, `itop` the
 * border plus padding above the content and `offset` the first painted row.
 *
 * Rows are painted in queue order, so row `i` is message `i`; a click outside the
 * region, below the painted messages or on the `+N more` tail yields -1 (nothing
 * to delete). `rtof` is blessed's fake->real map: a row a preview wrapped onto is
 * mapped back to the message it belongs to, so a wrap cannot delete its
 * neighbour. A row fitted to the bar's width never wraps
 * (`app/queue-rows.js#queuePreviewBudget`), so the map is only a safety net for a
 * terminal that disagrees with our own cell counting.
 *
 * Pure and defensive: a missing widget or click yields -1 too.
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

// The row formatting is a view of the queue, not part of its model: a row has to know
// the width of the bar it is painted in (app/queue-rows.js).
export * from './queue-rows.js';
