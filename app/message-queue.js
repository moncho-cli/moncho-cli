/**
 * The pending-message queue as a model, independent of any terminal widget.
 *
 * A turn can take minutes, and the input box is only armed between turns, so a
 * message typed while a request is in flight would otherwise go nowhere. The
 * queue stores it instead: **FIFO**, **verbatim** (the bytes the model receives
 * are the bytes the user typed), visible right above the input box, deletable one
 * row at a time, and drained by the host loop between two turns.
 *
 * The drain is the **whole queue, not the oldest message**: a user who queues three
 * notes in the same minute meant them as one instruction, and handing them over one
 * turn at a time would answer the first before the second was even read — working the
 * wrong task for a whole turn. `drainAll()` empties the queue at once and
 * `joinQueued()` is the single place that says how several messages become one prompt.
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
 * Turn everything waiting in the queue into the one prompt of the next turn.
 *
 * The messages are taken **in order, verbatim**, and joined by a blank line — nothing
 * else is added: no preamble, no numbering, no rewording. A preamble would be the
 * harness talking to the model in the user's own message, and the separator is the
 * minimum that keeps two notes from running into one sentence. A queue of **one** is
 * returned byte-for-byte, so the ordinary single-message case is exactly what it was
 * before batching existed.
 *
 * Pure: an array in, a string out.
 *
 * @param {Array<string|{text: string}>} messages queued messages, oldest first
 * @returns {string} the prompt, or `''` when nothing is waiting
 */
export function joinQueued(messages = []) {
  const texts = (Array.isArray(messages) ? messages : [])
    .map((entry) => (typeof entry === 'string' ? entry : String(entry?.text ?? '')))
    .filter((text) => text.trim() !== '');
  if (texts.length === 0) return '';
  if (texts.length === 1) return texts[0];
  return texts.join('\n\n');
}

/**
 * Take whatever is waiting out of the queue, as verbatim texts, oldest first.
 *
 * This is the **one drain rule**, and it has two callers because the queue has two
 * injection points: the host loop between two turns (`nextPrompt()`) and the turn loop
 * itself, which injects at the top of the per-call loop (`app/turn-runner.js#runTurn`,
 * task-backlog item 48). Both must agree on *which* messages came out and in what
 * order, so neither drains the queue itself.
 *
 * `drainAll` is preferred when the front end has it — the whole queue is one
 * instruction (`joinQueued()` says how it becomes one prompt) — and `dequeue` is the
 * single-message drain of a front end that has only that. A single message crosses
 * both paths identically, so the choice is a capability, never a behaviour change.
 *
 * Pure and synchronous: an array out, `[]` when nothing is waiting. Empty answers
 * (a front end with neither call, a `dequeue()` of `null`) are `[]` rather than a
 * throw, because "nothing was queued" is the ordinary case, not a failure.
 *
 * @param {object} [options]
 * @param {Function|null} [options.drainAll] the queue's batch drain
 * @param {Function|null} [options.dequeue]  the queue's single-message drain
 * @returns {Array<string|{text: string}>} the queued messages, oldest first
 */
export function takeQueued({ drainAll = null, dequeue = null } = {}) {
  const asList = (value) => {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
  };
  if (typeof drainAll === 'function') return asList(drainAll());
  if (typeof dequeue === 'function') return asList(dequeue());
  return [];
}

/**
 * The prompt a drain is worth: `takeQueued()` joined by `joinQueued()`, or `''` when
 * nothing was waiting.
 *
 * The empty string is the "nothing to inject" answer both injection points act on —
 * the host loop falls through to the front end's own question, and the turn loop leaves
 * the turn alone — so a drain and the decision it feeds are one call rather than two
 * that could disagree.
 */
export function takeQueuedPrompt(options = {}) {
  return joinQueued(takeQueued(options));
}

/**
 * The prompt of the next turn: **every** queued message when any is waiting,
 * otherwise the front end's own question. This is the *between-turns* injection
 * point (`app/session-loop.js`); the *mid-turn* one is `takeQueuedPrompt()` read by
 * `app/turn-runner.js#runTurn` at the top of its per-call loop (task-backlog item 48),
 * and both sit at a boundary where an injected message cannot split an assistant
 * `tool_calls` message from its `tool` results.
 *
 * `drainAll` is preferred when the front end has it: it empties the queue and the
 * batch becomes one prompt through `joinQueued`. `dequeue` is the single-message
 * drain of a front end that has only that, and a queue of one crosses both paths
 * identically.
 *
 * Pure and async, so the drain rule is unit tested without a pty or a loop.
 *
 * @param {object} options
 * @param {Function|null} [options.drainAll] the queue's batch drain (returns every text)
 * @param {Function|null} [options.dequeue]  the queue's single-message drain
 * @param {Function} options.ask             the front end's question()
 */
export async function nextPrompt({ drainAll = null, dequeue = null, ask = null } = {}) {
  // One drain rule, shared with the turn loop's mid-turn injection: `nextPrompt()`
  // differs from it only in what it does with an empty answer.
  const prompt = takeQueuedPrompt({ drainAll, dequeue });
  if (prompt !== '') return prompt;
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

  /**
   * Take **every** message out at once, oldest first; `[]` when the queue is empty.
   *
   * One notification for the whole batch, because the batch is one change: the bar
   * repaints once to an empty region instead of once per message.
   */
  const drainAll = () => {
    if (!items.length) return [];
    const drained = items;
    items = [];
    notify();
    return drained.map((item) => ({ ...item }));
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
    drainAll,
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
