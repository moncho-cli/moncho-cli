import test from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateRequestTokens,
  exceedsTokenBudget,
  formatTokenCount,
  formatUsage
} from '../utils/tokens.js';

/**
 * Character-based token estimation and budget reporting
 * (docs/context/token-accounting).
 *
 * Split out of tests/context-window.test.js so each suite stays small and named
 * after the capability it proves (tests/README.md); that suite keeps the
 * compaction, the live window and the compact_context tool.
 */

test('token estimates are additive, rounded up and never negative', () => {
  assert.equal(estimateMessageTokens('abcd'), 1);
  assert.equal(estimateMessageTokens('abcde'), 2);
  assert.equal(estimateMessagesTokens(['abcd', 'abcd']), 2);
  assert.equal(estimateMessageTokens(null), 0);
  assert.ok(estimateMessageTokens({ role: 'user', content: 'x'.repeat(100) }) > 100 / 4);
  assert.ok(estimateRequestTokens([{ role: 'user', content: 'hi' }], [{ type: 'function' }]) > 0);
});

test('budget helpers and formatting', () => {
  const messages = [{ role: 'user', content: 'x'.repeat(400) }];
  assert.equal(exceedsTokenBudget(messages, 1000), false);
  assert.equal(exceedsTokenBudget(messages, 10), true);
  assert.equal(exceedsTokenBudget(messages, 0), false); // 0 = no limit
  assert.equal(formatTokenCount(1500), '1.50k');
  assert.match(formatUsage(messages, 1000), /tokens \(\d+%\)$/);
  assert.match(formatUsage(messages, 0), /\(no limit\)$/);
});
