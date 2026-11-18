import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMessageQueue,
  nextPrompt,
  previewMessage,
  formatQueueRow,
  formatQueueRows,
  formatQueueTail,
  queueRowAt,
  QUEUE_PREVIEW_CHARS,
  QUEUE_MAX_ROWS,
  QUEUE_DELETE_MARKER,
} from '../app/message-queue.js';

/**
 * The pending-message queue as a model (task.md: "able to send messages at any
 * moment that are queued … and injected when possible … with an X that you can
 * delete them from the queue").
 *
 * Everything here is pure — no neo-blessed, no screen — so the order, the verbatim
 * text, the row formatting, the click geometry and the injection rule are proven
 * without a pty. The widget binding that paints these rows and queues a submission
 * while a request is in flight is proven in tests/message-queue-tui.test.js, and
 * the region it makes room for in tests/tui.test.js.
 */

test('createMessageQueue() keeps messages in FIFO order, verbatim', () => {
  const queue = createMessageQueue();
  assert.equal(queue.size, 0);
  assert.equal(queue.isEmpty, true);
  assert.equal(queue.peek(), null);
  assert.equal(queue.dequeue(), null, 'draining an empty queue is not an error');

  // A pasted block is one message: the newlines are part of the bytes.
  const pasted = 'line 1\nline 2\nline 3';
  const first = queue.enqueue(pasted);
  const second = queue.enqueue('  trailing spaces kept  ');

  assert.equal(queue.size, 2);
  assert.equal(queue.isEmpty, false);
  assert.ok(first.id && second.id && first.id !== second.id, 'each message gets its own id');

  // The stored text is the text that was typed: no trimming, no collapsing.
  assert.equal(queue.items[0].text, pasted);
  assert.equal(queue.items[1].text, '  trailing spaces kept  ');
  assert.equal(queue.peek().text, pasted, 'peek shows the oldest message');

  // FIFO: the oldest message comes out first.
  assert.equal(queue.dequeue().text, pasted);
  assert.equal(queue.dequeue().text, '  trailing spaces kept  ');
  assert.equal(queue.isEmpty, true);

  // An empty or blank message is not queued at all: there is nothing to inject.
  assert.equal(queue.enqueue(''), null);
  assert.equal(queue.enqueue('   \n  '), null);
  assert.equal(queue.enqueue(null), null);
  assert.equal(queue.enqueue(undefined), null);
  assert.equal(queue.size, 0);
});

test('createMessageQueue() notifies its subscribers on every change', () => {
  const queue = createMessageQueue();
  const seen = [];
  const unsubscribe = queue.subscribe((items) => seen.push(items.map((item) => item.text)));

  queue.enqueue('one');
  queue.enqueue('two');
  queue.remove(queue.items[0].id);
  queue.clear();

  assert.deepEqual(seen, [['one'], ['one', 'two'], ['two'], []]);

  // The listener receives a copy: mutating it cannot reach the queue.
  seen.at(-1).push('injected');
  assert.equal(queue.size, 0);

  unsubscribe();
  queue.enqueue('after unsubscribe');
  assert.equal(seen.length, 4, 'an unsubscribed listener is not called again');

  // A junk listener is harmless, and unsubscribing it twice is too.
  const noop = queue.subscribe(null);
  noop();
  assert.equal(queue.size, 1);
});

test('createMessageQueue() removes one message by id and clears the rest', () => {
  const queue = createMessageQueue();
  const ids = ['a', 'b', 'c'].map((text) => queue.enqueue(text).id);

  // Removing a middle message leaves the order of the others untouched.
  const removed = queue.remove(ids[1]);
  assert.equal(removed.text, 'b');
  assert.deepEqual(queue.items.map((item) => item.text), ['a', 'c']);
  assert.equal(queue.remove('msg-does-not-exist'), null, 'an unknown id removes nothing');
  assert.equal(queue.size, 2);

  // The removed id is never handed out again.
  const next = queue.enqueue('d');
  assert.ok(!ids.includes(next.id), 'ids are unique for the life of the queue');

  assert.equal(queue.clear(), 3, 'clear reports how many messages it dropped');
  assert.equal(queue.clear(), 0, 'clearing an empty queue changes nothing');
  assert.equal(queue.isEmpty, true);
});

test('previewMessage() flattens whitespace and truncates long text', () => {
  assert.equal(previewMessage('  hello   world  '), 'hello world');
  assert.equal(previewMessage('a\nb\r\nc\td'), 'a b c d', 'a pasted block shows as one row');
  assert.equal(previewMessage(null), '');
  assert.equal(previewMessage(undefined), '');

  const long = 'x'.repeat(QUEUE_PREVIEW_CHARS + 20);
  const preview = previewMessage(long);
  assert.equal(preview.length, QUEUE_PREVIEW_CHARS, 'the preview is capped');
  assert.ok(preview.endsWith('…'), 'the truncation is visible');
  assert.equal(previewMessage(long, { maxChars: 5 }), 'xxxx…');

  const exact = 'y'.repeat(QUEUE_PREVIEW_CHARS);
  assert.equal(previewMessage(exact), exact, 'a preview at the cap is not truncated');
});

test('formatQueueRows() paints one ✕ row per message, capped with a +N more tail', () => {
  assert.deepEqual(formatQueueRows([]), [], 'an empty queue has no rows');
  assert.equal(formatQueueTail(2), '+2 more');

  const messages = ['first', 'second', 'third'].map((text, index) => ({ id: `msg-${index}`, text }));
  assert.deepEqual(formatQueueRows(messages), [
    `${QUEUE_DELETE_MARKER} 1. first`,
    `${QUEUE_DELETE_MARKER} 2. second`,
    `${QUEUE_DELETE_MARKER} 3. third`,
  ]);

  // Every row carries the delete marker and the queue position, in queue order.
  assert.equal(formatQueueRow({ id: 'x', text: 'only' }, 0), `${QUEUE_DELETE_MARKER} 1. only`);
  assert.equal(formatQueueRow('bare string', 4), `${QUEUE_DELETE_MARKER} 5. bare string`);

  // More messages than the bar paints collapse into a single tail row.
  const many = Array.from({ length: QUEUE_MAX_ROWS + 3 }, (_, i) => ({ id: `m${i}`, text: `msg ${i}` }));
  const rows = formatQueueRows(many);
  assert.equal(rows.length, QUEUE_MAX_ROWS + 1, 'the cap plus the tail');
  assert.equal(rows.at(-1), '+3 more');
  assert.equal(rows.filter((row) => row.startsWith(QUEUE_DELETE_MARKER)).length, QUEUE_MAX_ROWS);
  assert.equal(rows[0], `${QUEUE_DELETE_MARKER} 1. msg 0`);
  assert.equal(rows[QUEUE_MAX_ROWS - 1], `${QUEUE_DELETE_MARKER} ${QUEUE_MAX_ROWS}. msg ${QUEUE_MAX_ROWS - 1}`);

  // maxRows: 0 keeps nothing but the count.
  assert.deepEqual(formatQueueRows(messages, { maxRows: 0 }), ['+3 more']);
});

test('queueRowAt() maps a click to the message under the cursor', () => {
  const messages = ['a', 'b', 'c'].map((text, index) => ({ id: `msg-${index}`, text }));
  // The region right above the input box: painted from screen row 14, one row of
  // border on top, so the first message row is screen row 15.
  const pos = { xi: 0, yi: 14 };
  const geometry = { pos, itop: 1, messages };

  assert.equal(queueRowAt({ ...geometry, data: { y: 15 } }), 0);
  assert.equal(queueRowAt({ ...geometry, data: { y: 16 } }), 1);
  assert.equal(queueRowAt({ ...geometry, data: { y: 17 } }), 2);

  // The border row and anything above the region delete nothing.
  assert.equal(queueRowAt({ ...geometry, data: { y: 14 } }), -1);
  assert.equal(queueRowAt({ ...geometry, data: { y: 0 } }), -1);
  // Nor does the `+N more` tail (one row past the last painted message).
  assert.equal(queueRowAt({ ...geometry, data: { y: 18 } }), -1);
  assert.equal(queueRowAt({ ...geometry, data: { y: 99 } }), -1);

  // An offset (a scrolled region) shifts the mapping.
  assert.equal(queueRowAt({ ...geometry, offset: 1, data: { y: 15 } }), 1);

  // A row a preview wrapped onto still resolves to the message it belongs to.
  assert.equal(queueRowAt({ ...geometry, rtof: [0, 1, 1, 2], data: { y: 17 } }), 1);

  // Junk never throws: a missing widget, a missing click, a NaN row.
  assert.equal(queueRowAt({ messages, data: { y: 15 } }), -1);
  assert.equal(queueRowAt({ ...geometry, data: null }), -1);
  assert.equal(queueRowAt({ ...geometry, data: { y: Number.NaN } }), -1);
  assert.equal(queueRowAt(), -1);
  assert.equal(queueRowAt({ ...geometry, data: { y: 15 }, messages: undefined }), -1);
});

test('nextPrompt() injects the oldest queued message between turns, else asks', async () => {
  const asked = [];
  const ask = async () => {
    asked.push('asked');
    return 'typed by the user';
  };

  // An empty queue falls through to the front end's own question.
  assert.equal(await nextPrompt({ dequeue: () => null, ask }), 'typed by the user');
  assert.equal(asked.length, 1);

  // A queued message wins, and the question is not asked at all.
  const queue = createMessageQueue();
  queue.enqueue('queued while the turn ran');
  assert.equal(
    await nextPrompt({ dequeue: () => queue.dequeue()?.text, ask }),
    'queued while the turn ran',
  );
  assert.equal(asked.length, 1, 'the front end was not asked');

  // No queue at all (the line CLI): the question is the only source.
  assert.equal(await nextPrompt({ ask }), 'typed by the user');
  assert.equal(asked.length, 2);
  // ... and neither side configured is not a crash.
  assert.equal(await nextPrompt(), null);
});

test('nextPrompt() drains one message per turn, in order', async () => {
  const queue = createMessageQueue();
  queue.enqueue('first');
  queue.enqueue('second');
  const dequeue = () => queue.dequeue()?.text;
  const ask = () => 'never asked while messages are waiting';

  assert.equal(await nextPrompt({ dequeue, ask }), 'first');
  assert.equal(await nextPrompt({ dequeue, ask }), 'second');
  assert.equal(await nextPrompt({ dequeue, ask }), 'never asked while messages are waiting');
  assert.equal(queue.size, 0);
});
