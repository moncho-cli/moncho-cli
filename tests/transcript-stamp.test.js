import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STAMP_RE, STAMP_WIDTH, formatStamp, withStamp, createStamper,
} from '../app/transcript-stamp.js';
import { TranscriptModel } from '../app/transcript.js';
import { createTranscriptView } from '../app/transcript-view.js';
import { classifyLine, colorizeLine, splitStamp } from '../app/theme.js';
import { createTui } from '../app/tui.js';
import { fakeTty, plainText, visible } from './support/tui-harness.js';

/**
 * The timestamp a conversation block carries in the TUI (task-backlog: "in the user
 * converstaion view (not sent to the model) show a timestamp on each block so the
 * user knows when that block appeared").
 *
 * The mark is presentation only: it lives on the transcript entry, it is painted by
 * the view, and it never reaches a chunk. Every case here checks one of those three
 * claims, from the pure formatter up to the real screen.
 */

/** A frozen clock, so the assertions can name the exact mark. */
const at = (h, m, s) => new Date(2026, 0, 2, h, m, s);

/** A widget stub with the geometry the view reads, so no screen is needed. */
function widgetStub() {
  let content = '';
  return {
    setContent: (value) => { content = String(value); },
    getContent: () => content,
    setScroll: () => {},
    setScrollPerc: () => {},
    getScroll: () => 0,
    getScrollPerc: () => 100,
    getScrollHeight: () => 1,
    height: 10,
    iheight: 8,
  };
}

test('formatStamp() writes one HH:MM:SS mark in local time', () => {
  assert.equal(formatStamp(at(9, 5, 7)), '09:05:07');
  assert.equal(formatStamp(at(23, 59, 59)), '23:59:59');
  assert.equal(STAMP_WIDTH, 8);
  assert.equal(formatStamp(at(9, 5, 7)).length, STAMP_WIDTH);
  // Junk is an empty mark, never "NaN:NaN:NaN" and never a crash.
  assert.equal(formatStamp(new Date('nonsense')), '');
  assert.equal(formatStamp('not a date'), '');
});

test('withStamp() prefixes a display line and refuses a fake mark', () => {
  assert.equal(withStamp('hello', '09:05:07'), '09:05:07 hello');
  // A stamp that does not look like one is dropped rather than written into a row.
  assert.equal(withStamp('hello', 'noon'), 'hello');
  assert.equal(withStamp('hello', null), 'hello');
  assert.equal(withStamp('hello'), 'hello');
  assert.ok(STAMP_RE.test('09:05:07 '));
  assert.equal(STAMP_RE.test('9:05:07 '), false);
});

test('createStamper() takes the time from the caller and can be switched off', () => {
  const stamp = createStamper({ now: () => at(12, 34, 56) });
  assert.equal(stamp(), '12:34:56');
  // A front end that wants no marks gets none: the hook answers null, so withStamp()
  // leaves every line untouched.
  assert.equal(createStamper({ enabled: false })(), null);
  // An unreadable clock is also "no mark", so the row stays clean.
  assert.equal(createStamper({ now: () => 'rubbish' })(), null);
});

test('the transcript model stamps an entry once and keeps the payload verbatim', () => {
  const model = new TranscriptModel();
  model.addLine('plain line', { stamp: '09:05:07' });
  model.addBlock({
    header: '[read_file Output]',
    body: 'payload',
    stamp: '09:05:08',
  });

  const lines = model.lines;
  assert.equal(lines[0], '09:05:07 plain line');
  // The block header carries the mark in front of its marker, so the glyph stays at
  // the head of the row and the click math is unchanged.
  assert.match(lines[1], /^09:05:08 [▸▾] \[read_file Output\] — 7 char response/);
  // The payload never carries a mark: only the header of a block does.
  assert.equal(model.blocks[0].body, 'payload');
  assert.doesNotMatch(model.blocks[0].body, STAMP_RE);
});

test('the transcript view stamps the first non-blank line of each entry', () => {
  const added = [];
  const view = createTranscriptView({
    widget: widgetStub(),
    refresh: () => {},
    stamp: () => '09:05:07',
  });
  // Spy on the model seam: the stamp the view passes per display line is the unit
  // under test, not the widget's painted content.
  const original = view.model.addLine.bind(view.model);
  view.model.addLine = (text, options = {}) => {
    added.push({ text, stamp: options.stamp ?? null });
    return original(text, options);
  };

  // A multi-line reply is stamped once: a long answer must not become a column of
  // identical times. The blank opening line is skipped, so the mark lands where the
  // text really starts.
  view.log('\nfirst line\nsecond line');
  assert.deepEqual(added.map((entry) => entry.stamp), [null, '09:05:07', null]);
  view.close();
});

test('setStamping(false) marks nothing, so a replay shows no reload time', () => {
  const added = [];
  const view = createTranscriptView({
    widget: widgetStub(),
    refresh: () => {},
    stamp: () => '09:05:07',
  });
  const original = view.model.addLine.bind(view.model);
  view.model.addLine = (text, options = {}) => {
    added.push(options.stamp ?? null);
    return original(text, options);
  };

  view.setStamping(false);
  view.log('replayed row');
  assert.deepEqual(added, [null]);

  view.setStamping(true);
  view.log('live row');
  assert.deepEqual(added, [null, '09:05:07']);
  view.close();
});

test('the palette sees through a stamp and paints it as chrome', () => {
  // Classification ignores the mark: a stamped row still classifies as its kind.
  assert.equal(classifyLine('09:05:07 [read_file Output]'), 'tool');
  assert.equal(classifyLine('09:05:07 [Tracking] done'), 'tracking');
  assert.equal(classifyLine('09:05:07 prose'), null);
  assert.deepEqual(splitStamp('09:05:07 prose'), { stamp: '09:05:07', rest: 'prose' });
  assert.deepEqual(splitStamp('prose'), { stamp: '', rest: 'prose' });
  // The mark is painted in the chrome (grey) colour and the row keeps its own colour.
  const painted = colorizeLine('09:05:07 [read_file Output]');
  assert.match(painted, /\{grey-fg\}09:05:07\{\/grey-fg\} /);
  assert.match(painted, /\{bright-cyan-fg\}\[read_file Output\]\{\/bright-cyan-fg\}/);
});

test('the real TUI stamps each block and the reload marks nothing', async () => {
  const input = fakeTty();
  const output = fakeTty();
  const tui = createTui({
    input,
    output,
    modelLabel: 'probe',
    stamp: () => '09:05:07',
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));

    tui.log('an answer');
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(visible(tui), /09:05:07 an answer/);

    // The stamp is display only: the transcript text carries it and the frame shows
    // it, while the TUI holds no context chunk at all.
    assert.match(plainText(tui.transcript.getContent()), /09:05:07/);

    // A reloaded conversation appeared in a past run: it is not marked with now.
    tui.reload([{ role: 'assistant', content: 'old answer' }]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.doesNotMatch(visible(tui), /09:05:07 old answer/);
    assert.match(visible(tui), /old answer/);
  } finally {
    tui.close();
    input.destroy();
    output.destroy();
  }
});
