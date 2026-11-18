import {
  createMessageQueue,
  formatQueueRows,
  queueRowAt,
  QUEUE_MAX_ROWS,
  QUEUE_DELETE_MARKER,
} from './message-queue.js';

/**
 * Bind the pending-message queue to the blessed region right above the input box.
 *
 * The model (app/message-queue.js) owns the order, the verbatim text and the row
 * formatting; this module is only the screen binding: it paints the rows, resizes
 * the region so the status bar, the model row and the transcript shift up by the
 * queue height, and deletes the message under a click.
 *
 * Kept apart from app/tui.js so the screen wiring stays thin, and pure in the
 * model sense: with no widget the whole thing still works (it just paints
 * nothing), which is how the line CLI and the unit tests drive it.
 */
export function createQueueBar({
  widget = null,
  queue = createMessageQueue(),
  setHeight = () => {},
  refresh = () => {},
  maxRows = QUEUE_MAX_ROWS,
} = {}) {
  let closed = false;
  let paintedHeight = 0;

  /** The display rows of the queue, in queue order, tail included. */
  const rows = () => formatQueueRows(queue.items, { maxRows });

  /**
   * Repaint from the model: the rows become the widget content and the region is
   * resized to them (0 rows hides it and restores the anchors above it).
   */
  const paint = () => {
    if (closed) return [];
    const lines = rows();
    if (widget) widget.setContent(lines.join('\n'));
    if (lines.length !== paintedHeight) {
      paintedHeight = lines.length;
      setHeight(lines.length);
    }
    refresh();
    return lines;
  };

  // Every mutation (enqueue, dequeue, remove, clear) repaints: the widget is a
  // view of the model, never a second copy of it.
  const unsubscribe = queue.subscribe(() => {
    paint();
  });

  /**
   * A click inside the region deletes the message on that row and nothing else.
   * Wrapped rows are mapped back through the widget's fake->real table first, so
   * a preview that happens to wrap cannot delete its neighbour.
   */
  const clickAt = (data) => {
    if (closed || !widget || !data) return null;
    const items = queue.items;
    const index = queueRowAt({
      data,
      pos: widget.lpos,
      itop: widget.itop || 0,
      rtof: widget._clines && widget._clines.rtof,
      messages: items,
    });
    if (index < 0) return null;
    return queue.remove(items[index].id);
  };

  return {
    queue,
    paint,
    rows,
    clickAt,
    /** Queue one message verbatim; a blank message is not queued (null). */
    enqueue: (text) => queue.enqueue(text),
    /** Drop the oldest message and return its text, or null when empty. */
    dequeue: () => {
      const item = queue.dequeue();
      return item ? item.text : null;
    },
    remove: (id) => queue.remove(id),
    clear: () => queue.clear(),
    subscribe: (listener) => queue.subscribe(listener),
    get items() {
      return queue.items;
    },
    get count() {
      return queue.size;
    },
    /** Rows currently painted; 0 while the queue is empty. */
    get height() {
      return paintedHeight;
    },
    close() {
      closed = true;
      unsubscribe();
    },
  };
}

/**
 * Define the queue surface the host loop and the tests use onto `target`:
 * `dequeue()` hands the host the next message verbatim (or null), `queuedCount`
 * and `queued` are read-only views, and `clickQueue()`/`removeQueued()` are the
 * deletion paths.
 *
 * The accessors are **defined**, never spread: spreading an object literal
 * evaluates its getters once, which would freeze `queuedCount` at the value the
 * queue had when the TUI was built.
 */
export function queueSurface(queue, target = {}) {
  return Object.defineProperties(target, {
    /** Drop the oldest queued message and return its verbatim text, or null. */
    dequeue: { value: () => queue.dequeue(), enumerable: true },
    /** How many messages are waiting. */
    queuedCount: { get: () => queue.count, enumerable: true },
    /** The queued messages, oldest first (a copy: mutating it changes nothing). */
    queued: { get: () => queue.items, enumerable: true },
    /** The rows the queue bar paints, tail included (used by the tests). */
    queueRows: { value: () => queue.rows(), enumerable: true },
    /** Delete one queued message by id; null when the id is unknown. */
    removeQueued: { value: (id) => queue.remove(id), enumerable: true },
    /** A click on the queue bar deletes the message on that row. */
    clickQueue: { value: (data) => queue.clickAt(data), enumerable: true },
    /** Rows the bar paints right now (the region height). */
    queueHeight: { get: () => queue.height, enumerable: true },
  });
}

export { createMessageQueue, formatQueueRows, queueRowAt, QUEUE_MAX_ROWS, QUEUE_DELETE_MARKER };
