import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMessageQueue,
  nextPrompt,
  queueRowAt,
} from '../app/message-queue.js';

/**
 * The pending-message queue as a model (task.md: "able to send messages at any
 * moment that are queued … and injected when possible … with an X that you can
 * delete them from the queue").
 *
 * Everything here is pure — no neo-blessed, no screen — so the order, the verbatim
 * text, the click geometry and the injection rule are proven without a pty. How a
 * message is *drawn* (the rows, the width budget) lives in tests/queue-rows.test.js,
 * and the widget binding that paints those rows and queues a submission while a
 * request is in flight is proven in tests/message-queue-tui.test.js.
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

  // A row a preview wrapped onto still resolves to the message it belongs to: a row is
  // fitted to the bar's width, so this is the safety net for a terminal that disagrees
  // with our own cell counting.
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
