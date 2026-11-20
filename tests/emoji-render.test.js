import test from 'node:test';
import assert from 'node:assert/strict';

import { displayWidth, graphemes } from '../app/cell-width.js';
import { formatLastPromptHint, LAST_PROMPT_LABEL } from '../app/input-hint.js';
import { formatNoticeText } from '../app/notice-overlay.js';
import { composeStatusRow } from '../app/tui-render.js';
import { withTui, visible, statusRow } from './support/tui-harness.js';

/**
 * Unicode and emoji reach the conversation intact (docs/interface/prompt-editor).
 *
 * Every row that has to fit a width — the last-prompt hint, a notice, the status
 * bar with its right-aligned meter, a queued message — measures in **display
 * cells**, and every truncation is made **between grapheme clusters**. That is what
 * stops a terminal painting the replacement glyph where an emoji was cut in half,
 * and what stops a wide glyph pushing the context meter off the right edge.
 */

/** True when the text contains a lone surrogate (half of a cut character). */
function hasLoneSurrogate(text) {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);
}

test('formatLastPromptHint() truncates between clusters, never through an emoji', () => {
  const prompt = '👍🏽'.repeat(40);
  const hint = formatLastPromptHint(prompt, 20);

  assert.equal(hasLoneSurrogate(hint), false, 'no half character is left behind');
  // The label plus what was kept plus the ellipsis: the cap counts clusters.
  const body = hint.slice(LAST_PROMPT_LABEL.length);
  assert.equal(graphemes(body).length, 20);
  assert.equal(body.endsWith('…'), true);
  // A short prompt is untouched, emoji and all.
  assert.equal(formatLastPromptHint('ship it 🚀', 120), `${LAST_PROMPT_LABEL}ship it 🚀`);
});

test('formatNoticeText() truncates between clusters, never through an emoji', () => {
  const notice = formatNoticeText(`${'🎯'.repeat(50)} done`, 12);
  assert.equal(hasLoneSurrogate(notice), false);
  assert.equal(graphemes(notice).length, 12);
  assert.equal(notice.endsWith('…'), true);
  // Nothing narrows it: a notice that fits keeps every glyph whole.
  assert.equal(formatNoticeText('👨‍👩‍👧 joined'), '👨‍👩‍👧 joined');
});

test('composeStatusRow() measures in cells, so an emoji cannot shift the meter', () => {
  const meter = '2.4k / 8.0k tokens (30%)';
  // The status text carries a wide glyph: padding by `.length` would leave the meter
  // a cell short of the edge, because `🚀` is one code point of two columns.
  const row = composeStatusRow('🚀 working', meter, 40);
  assert.equal(displayWidth(row), 40, 'the row is exactly the width it was given');
  assert.ok(row.endsWith(meter), 'the meter is still pinned to the right edge');
  assert.ok(row.startsWith('🚀 working'));

  // The same holds when the left text has to be cut: the cut lands between clusters.
  const narrow = composeStatusRow(`🚀${'🚀'.repeat(20)}`, meter, 30);
  // A two-cell glyph cannot fill a one-cell gap, so the rule is that the row is never
  // *wider* than the width it was given, and the meter stays whole at the edge.
  assert.ok(displayWidth(narrow) <= 30, `row is ${displayWidth(narrow)} cells wide`);
  assert.ok(narrow.endsWith(meter));
  assert.equal(hasLoneSurrogate(narrow), false);
});

test('the conversation shows an emoji intact in the real TUI', async () => {
  await withTui((tui) => {
    tui.log('deployed 👍🏽 and shipped 🚀');
    const text = visible(tui);
    assert.match(text, /deployed 👍🏽 and shipped 🚀/);
    assert.equal(hasLoneSurrogate(text), false, 'the transcript holds whole characters');

    // And the status bar keeps its meter on the edge with a wide glyph on the left.
    tui.setStatus('🚀 2.4k / 8.0k tokens (30%)');
    const row = statusRow(tui);
    assert.equal(row.endsWith('2.4k / 8.0k tokens (30%)'), true, `got ${JSON.stringify(row)}`);
  });
});
