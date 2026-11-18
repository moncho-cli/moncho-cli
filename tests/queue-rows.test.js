import test from 'node:test';
import assert from 'node:assert/strict';

import {
  displayWidth,
  truncateToWidth,
  queuePreviewBudget,
  previewMessage,
  formatQueueRow,
  formatQueueRows,
  QUEUE_PREVIEW_CHARS,
  QUEUE_MAX_ROWS,
  QUEUE_DELETE_MARKER,
} from '../app/queue-rows.js';

/**
 * How a queued message is drawn (task-backlog: "the messages in queue get strangely
 * truncated, too soon, i cant read whats there").
 *
 * A row has to know one thing about the screen — the width it really has — and it knows
 * it as a number of cells, so everything here is pure and runs without a pty. The rule
 * the width exists for is: **one row per message, never wrapped**, because a row that
 * wrapped past the region's height was clipped by the widget and the end of the message
 * vanished with no `…`. The real bar is driven through `createTui()` in
 * tests/message-queue-tui.test.js.
 */

test('displayWidth() and truncateToWidth() count cells, not characters', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth(''), 0);
  assert.equal(displayWidth(null), 0);
  // A wide glyph occupies two cells, a combining mark none: a row holding them is not
  // the same width as its character count.
  assert.equal(displayWidth('漢'), 2);
  assert.equal(displayWidth('e\u0301'), 1, 'a combining accent adds no cell');

  // Truncation is charged against cells, so the result never exceeds the budget.
  assert.equal(truncateToWidth('abcdef', 4), 'abc…');
  assert.equal(truncateToWidth('abcd', 4), 'abcd', 'a text at the cap is not truncated');
  assert.equal(truncateToWidth('漢漢漢', 5), '漢漢…', 'two wide glyphs + ellipsis = 5 cells');
  assert.equal(displayWidth(truncateToWidth('漢'.repeat(50), 9)), 9);

  // A nonsense budget is not a zero-width row: it falls back to the no-width cap,
  // exactly like a caller that never passed one.
  assert.equal(truncateToWidth('anything', 0), 'anything');
  assert.equal(truncateToWidth('x'.repeat(80), 0).length, QUEUE_PREVIEW_CHARS);
});

test('queuePreviewBudget() spends the width on the preview, keeping the marker', () => {
  // No width at all (before the first layout, or a caller with no screen) keeps the
  // historical cap.
  assert.equal(queuePreviewBudget(), QUEUE_PREVIEW_CHARS);
  assert.equal(queuePreviewBudget({ columns: 0 }), QUEUE_PREVIEW_CHARS);

  // With a width, the prefix is taken off first: `✕ 12. ` is six cells, marker included.
  assert.equal(queuePreviewBudget({ columns: 118, prefix: `${QUEUE_DELETE_MARKER} 12. ` }), 112);
  assert.equal(queuePreviewBudget({ columns: 20, prefix: `${QUEUE_DELETE_MARKER} 1. ` }), 15);

  // A bar narrower than its own prefix can never produce a negative budget.
  assert.equal(queuePreviewBudget({ columns: 3, prefix: `${QUEUE_DELETE_MARKER} 1. ` }), 1);
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

test('formatQueueRow() fits a long message to the width the row really has', () => {
  const message = { id: 'm1', text: 'x'.repeat(400) };

  // The whole cell budget is used: 118 cells of bar, minus `✕ 1. ` (5) = 113.
  const wide = formatQueueRow(message, 0, { columns: 118 });
  assert.equal(displayWidth(wide), 118, 'the row uses the width it was given');
  assert.ok(wide.startsWith(`${QUEUE_DELETE_MARKER} 1. `), 'the marker and position stay');
  assert.ok(wide.endsWith('…'), 'the truncation is visible');

  // A narrow bar is respected exactly, and the marker is still there.
  const narrow = formatQueueRow(message, 0, { columns: 24 });
  assert.equal(displayWidth(narrow), 24);
  assert.match(narrow, /^✕ 1\. /);

  // Without a width the old cap applies, so a caller with no screen is unchanged.
  const blind = formatQueueRow(message, 0);
  assert.equal(displayWidth(blind), QUEUE_PREVIEW_CHARS + 5);

  // A preview inside the budget is not touched at all.
  assert.equal(formatQueueRow('short note', 0, { columns: 118 }), '✕ 1. short note');
});

test('formatQueueRows() paints one row per message, fitted and capped by maxRows', () => {
  const long = 'y'.repeat(300);
  const messages = [{ id: 'a', text: long }, { id: 'b', text: 'second' }];

  const rows = formatQueueRows(messages, { columns: 60 });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(displayWidth(row) <= 60, `row overflows the bar: ${displayWidth(row)} cells`);
  }
  assert.equal(rows[1], '✕ 2. second', 'a short message is shown as it is');

  // Without a width the fallback cap is what is applied.
  const blindRows = formatQueueRows(messages);
  assert.equal(displayWidth(blindRows[0]), QUEUE_PREVIEW_CHARS + 5);

  // The `+N more` tail and the row cap are unchanged by the width rule.
  const many = Array.from({ length: QUEUE_MAX_ROWS + 2 }, (_, i) => ({ id: `m${i}`, text: long }));
  const capped = formatQueueRows(many, { columns: 40 });
  assert.equal(capped.length, QUEUE_MAX_ROWS + 1);
  assert.equal(capped.at(-1), '+2 more');
  for (const row of capped) assert.ok(displayWidth(row) <= 40);

  // maxRows: 0 keeps nothing but the count.
  assert.deepEqual(formatQueueRows(messages, { maxRows: 0 }), ['+2 more']);
});
