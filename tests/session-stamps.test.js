import test from 'node:test';
import assert from 'node:assert/strict';

import { ContextWindow } from '../app/context-window.js';
import { replayChunks, renderReplay, reloadConversation } from '../app/session-replay.js';
import { serializeSession, sessionChunks, sessionStamps } from '../utils/session-format.js';
import {
  NO_STAMP, isStamp, stampRepeated, normalizeStamps, alignStamps,
} from '../utils/chunk-stamps.js';
import { formatStampAt, stampDay, weekdayOf, dayDividerFor } from '../utils/session-time.js';
import { createTranscriptView } from '../app/transcript-view.js';
import { withTui, visible, plainText } from './support/tui-harness.js';

/**
 * The time each block of a resumed conversation shows (docs/interface/session-stamps).
 *
 * A reloaded transcript used to carry no times at all: the live mark is taken from the
 * clock, and a replay must not claim a past row happened at the moment the file was
 * reopened. These cases prove the times are *stored* beside the chunks — never on them,
 * because the chunks are sent to the provider verbatim — and that a replay paints the
 * stored instant, with a divider wherever the calendar day changes.
 */

const flush = async (rounds = 3) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A frozen clock, so a mark is a known instant rather than "now". */
const at = (iso) => new Date(iso);

test("a chunk's time is recorded beside the chunks, never on a chunk", () => {
  const window = new ContextWindow({ now: () => at('2026-11-20T08:00:00.000Z') });
  const first = { role: 'user', content: 'one' };
  window.add(first);
  window.addMany([{ role: 'assistant', content: 'two' }, { role: 'tool', content: 'three' }]);

  assert.equal(window.stamps.length, window.chunks.length, 'one time per chunk');
  assert.equal(window.stamps[0], '2026-11-20T08:00:00.000Z');

  // The bookkeeping never rides on a message: the chunks are sent verbatim.
  for (const chunk of window.chunks) {
    assert.equal('stamp' in chunk, false, 'a chunk carries no mark');
    assert.equal('ts' in chunk, false, 'a chunk carries no timestamp field');
  }

  // A batch appended in one call is one moment, not one reading per chunk.
  assert.deepEqual(window.stamps, stampRepeated(at('2026-11-20T08:00:00.000Z'), 3));

  // A short marks list is padded rather than shifted, and junk is no mark at all.
  assert.deepEqual(normalizeStamps(['junk'], 3), [NO_STAMP, NO_STAMP, NO_STAMP]);
  assert.equal(isStamp('nonsense'), false);
  assert.equal(isStamp(null), false);
});

test("a compaction keeps the survivors' marks and dates the summary", async () => {
  const before = ['2026-11-20T08:00:00.000Z', '2026-11-20T08:01:00.000Z', '2026-11-20T08:02:00.000Z'];
  const older = { role: 'user', content: 'the old ask' };
  const big = { role: 'assistant', content: 'B'.repeat(4000) };
  const kept = { role: 'assistant', content: 'kept' };
  const chunks = [older, big, kept];

  // The real compaction path, so the identity of the survivors is what is tested.
  const { compactChunks } = await import('../utils/compaction.js');
  const { chunks: next } = await compactChunks(chunks, { callModel: async () => 'a summary' });

  const marks = alignStamps({
    previousChunks: chunks,
    previousStamps: before,
    nextChunks: next,
    fallback: '2026-11-21T09:30:00.000Z',
  });

  assert.equal(marks.length, next.length, 'rebuilt to the new length, never sliced');
  assert.equal(marks[0], '2026-11-21T09:30:00.000Z', 'the summary takes the moment of the compaction');
  const keptIndex = next.indexOf(kept);
  assert.equal(marks[keptIndex], before[2], 'a chunk that survived keeps its own time');
});

test('the record carries the times, and an older record yields one null per chunk', () => {
  const chunks = [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }];
  const stamps = ['2026-11-20T08:00:00.000Z', '2026-11-20T08:01:00.000Z'];

  const record = serializeSession({ id: 'stamped', createdAt: '2026-11-20T08:00:00.000Z', chunks, stamps });
  assert.deepEqual(record.stamps, stamps);
  assert.deepEqual(sessionStamps(record), stamps);
  assert.deepEqual(sessionChunks(record), chunks, 'the conversation itself is unchanged');

  // A record written before the field existed still parses, and answers one null per
  // chunk so a caller can index the list without a length check.
  const older = serializeSession({ id: 'older', createdAt: '2026-11-20T08:00:00.000Z', chunks });
  assert.equal('stamps' in older, false, 'no empty field is written for a conversation without times');
  assert.deepEqual(sessionStamps(older), [null, null]);
});

test('a stored instant renders in local time, and a day divider names the day', () => {
  const at = new Date(2026, 10, 20, 7, 5, 9);
  assert.equal(formatStampAt(at), '07:05:09');
  assert.equal(formatStampAt(at).length, 8, 'the same eight-character shape as the live mark');
  assert.equal(stampDay(at), '2026-11-20');
  assert.equal(weekdayOf('2026-11-20'), 'Friday');
  assert.equal(dayDividerFor('2026-11-20'), '--- 2026-11-20, Friday ---');

  // Junk is no mark, never a wrong one.
  assert.equal(formatStampAt('nonsense'), '');
  assert.equal(stampDay('nonsense'), '');
  assert.equal(weekdayOf('not-a-day'), '');
  assert.equal(dayDividerFor(null), '');
});

test('replay marks each entry and opens each calendar day once', () => {
  const chunks = [
    { role: 'user', content: 'day one' },
    { role: 'assistant', content: 'one' },
    { role: 'user', content: 'day two' },
    { role: 'assistant', content: 'two' },
  ];
  const stamps = [
    '2026-11-20T20:00:00.000Z',
    '2026-11-20T20:01:00.000Z',
    '2026-11-21T09:00:00.000Z',
    '2026-11-21T09:01:00.000Z',
  ];

  const { ops } = replayChunks(chunks, { stamps });
  const dividers = ops.filter((op) => op.kind === 'log' && String(op.text).startsWith('--- 20'));
  // One divider per calendar day, not one per row: the second row of a day is silent.
  assert.equal(dividers.length, 2);
  assert.deepEqual(dividers.map((op) => op.text.slice(4, 14)), ['2026-11-20', '2026-11-21']);

  // Each entry carries its own stored mark, in local time.
  const marked = ops.filter((op) => typeof op.stamp === 'string');
  assert.equal(marked.length, 4, 'one mark per entry');
  assert.equal(marked[0].stamp, formatStampAt(stamps[0]));
  assert.equal(marked[2].stamp, formatStampAt(stamps[2]), 'a mark answers for its own chunk');
});

test('a session without stored times replays unmarked, byte-for-byte as before', () => {
  const chunks = [
    { role: 'user', content: 'read the fixture' },
    { role: 'assistant', content: 'All done.' },
  ];
  const { ops } = replayChunks(chunks);

  // No mark key at all, so an older session replays to exactly the ops it always did.
  assert.equal(ops.some((op) => 'stamp' in op), false);
  assert.equal(ops.some((op) => op.kind === 'log' && String(op.text).startsWith('--- 20')), false);

  // A record that kept the field but with a junk entry marks nothing either.
  const junk = replayChunks(chunks, { stamps: ['nonsense', null] });
  assert.equal(junk.ops.some((op) => 'stamp' in op), false);
});

test('the TUI reload paints the stored marks and the line CLI prints no options object', async () => {
  const chunks = [{ role: 'assistant', content: 'old answer' }];
  const stamps = [new Date(2026, 10, 20, 9, 5, 7).toISOString()];

  // The line CLI: a plain log receives text only — never an options object to print.
  const printed = [];
  reloadConversation(chunks, { log: (...args) => printed.push(args), stamps });
  assert.ok(printed.length >= 2, 'a divider and the reply');
  for (const args of printed) {
    assert.equal(args.length, 1, 'a plain log is handed one argument');
    assert.equal(typeof args[0], 'string');
  }

  // The TUI paints the stored instant instead of its own clock.
  await withTui(async (tui) => {
    await flush();
    tui.reload(chunks, { stamps });
    await flush();

    const text = visible(tui);
    assert.match(text, /09:05:07/, 'the stored time is painted');
    assert.match(text, /--- \d{4}-\d{2}-\d{2}, \w+ ---/, 'the day is named once');
    assert.match(plainText(tui.transcript.getContent()), /09:05:07 old answer/);
  });
});

test('the transcript view takes a stored mark ahead of its own clock', () => {
  // The unit under test is the mark the view passes per display line.
  const added = [];
  const widget = {
    setContent: () => {}, getContent: () => '', setScroll: () => {}, setScrollPerc: () => {},
    getScroll: () => 0, getScrollPerc: () => 100, getScrollHeight: () => 1, height: 10, iheight: 8,
  };
  const view = createTranscriptView({ widget, refresh: () => {}, stamp: () => '23:59:59' });
  const original = view.model.addLine.bind(view.model);
  view.model.addLine = (text, options = {}) => {
    added.push(options.stamp ?? null);
    return original(text, options);
  };

  // An explicit stored mark wins; without one the clock still answers, so the live
  // path is untouched.
  view.log('stored row', { stamp: '09:05:07' });
  view.log('live row');
  assert.deepEqual(added, ['09:05:07', '23:59:59']);
  view.close();
});