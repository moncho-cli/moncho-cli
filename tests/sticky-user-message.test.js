import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STICKY_MARKER,
  isStickyDue,
  lastUserEntry,
  stickyLine,
  stickyText,
} from '../app/transcript-sticky.js';
import { createStickyBar } from '../app/sticky-bar.js';
import { displayWidth } from '../app/cell-width.js';
import { withTui } from './support/tui-harness.js';

/** A display-row record, the shape `TranscriptModel#lineRecords()` produces. */
const row = (text, role = null, stamp = null) => ({ text, role, stamp, color: null });

test('lastUserEntry() finds the newest user line and skips the band margins', () => {
  const records = [
    row('10:00:00 do the thing', 'user', '10:00:00'),
    row('', 'user'), // the band's top margin
    row('10:00:01 model prose', 'assistant', '10:00:01'),
    row('some tool line'),
    row('', 'user'), // the band's bottom margin
  ];
  const entry = lastUserEntry(records);
  assert.equal(entry.text, '10:00:00 do the thing');
  assert.equal(entry.stamp, '10:00:00');
  assert.equal(entry.index, 0);
});

test('lastUserEntry() returns the latest of several prompts, and null before any', () => {
  assert.equal(lastUserEntry([]), null);
  assert.equal(lastUserEntry([row('assistant only', 'assistant')]), null);
  const entry = lastUserEntry([
    row('first prompt', 'user', '09:00:00'),
    row('reply', 'assistant', '09:00:01'),
    row('second prompt', 'user', '09:05:00'),
  ]);
  assert.equal(entry.index, 2);
  assert.equal(entry.stamp, '09:05:00');
});

test('isStickyDue() pins only once the real row has left the top', () => {
  // The prompt is display row 10; a viewport of 20 rows starting at 0 still shows it.
  assert.equal(isStickyDue({ index: 10, scrollBase: 0, visibleHeight: 20 }), false);
  assert.equal(isStickyDue({ index: 10, scrollBase: 10, visibleHeight: 20 }), false);
  // Once the first painted row is *past* it, the prompt is off the top.
  assert.equal(isStickyDue({ index: 10, scrollBase: 11, visibleHeight: 20 }), true);
  assert.equal(isStickyDue({ index: 10, scrollBase: 400, visibleHeight: 20 }), true);
});

test('isStickyDue() says no without a prompt or without geometry', () => {
  assert.equal(isStickyDue({ index: -1, scrollBase: 50, visibleHeight: 20 }), false);
  assert.equal(isStickyDue({ index: 3, scrollBase: 50, visibleHeight: 0 }), false);
  assert.equal(isStickyDue(), false);
});

test('stickyText() flattens a prompt to its first line and fits it in cells', () => {
  assert.equal(stickyText('fix the parser\nplease', 40), 'fix the parser');
  // The echo's own stamp is stripped: the pin paints its own mark.
  assert.equal(stickyText('10:00:00 fix the parser', 40), 'fix the parser');
  // Truncation is counted in cells and marked, never cut mid-character.
  assert.equal(stickyText('abcdefghij', 5), 'abcd…');
  assert.equal(stickyText('', 40), '');
});

test('stickyLine() opens with the marker, carries the stamp and respects the width', () => {
  const line = stickyLine({ text: 'do the thing', stamp: '10:00:00', width: 40 });
  assert.ok(line.startsWith(`${STICKY_MARKER} `));
  assert.ok(line.includes('10:00:00'));
  assert.ok(line.includes('do the thing'));

  // Without a stamp the row is just the marker and the text.
  assert.equal(stickyLine({ text: 'hi', stamp: null, width: 40 }), `${STICKY_MARKER} hi`);

  // A long prompt is cut so the whole row — prefix included — fits the width.
  const wide = stickyLine({ text: 'x'.repeat(200), stamp: '10:00:00', width: 30 });
  assert.ok(wide.length <= 30, `row was ${wide.length} chars`);
});

test('the bar pins the prompt once it scrolls away, and hides again on the way back', () => {
  // A transcript stub in the shape the bar reads: records, scroll base and viewport height.
  const records = [
    row('10:00:00 do the thing', 'user', '10:00:00'),
    ...Array.from({ length: 40 }, (_, i) => row(`10:00:0${i % 9} model line ${i}`, 'assistant')),
  ];
  const transcript = {
    lineRecords: () => records,
    childBase: 0,
    height: 12,
    iheight: 6,
    lpos: { yi: 1, xi: 0 },
    ileft: 1,
    itop: 1,
  };

  const bar = createStickyBar({ screen: null, transcript, records: () => records });
  // Parked at the bottom: the prompt row is off the top, so the pin is up.
  transcript.childBase = 20;
  const line = bar.paint();
  assert.ok(line.includes('do the thing'));
  assert.ok(line.includes('10:00:00'));

  // Scrolled back to the very top: the real row is on screen, so the pin steps aside.
  transcript.childBase = 0;
  assert.equal(bar.paint(), '');
});

test('the bar hides itself when the user has not spoken yet', () => {
  const transcript = {
    lineRecords: () => [row('a model line', 'assistant')],
    childBase: 30,
    height: 12,
    iheight: 6,
    lpos: { yi: 1, xi: 0 },
    ileft: 1,
    itop: 1,
  };
  const bar = createStickyBar({ transcript, records: () => transcript.lineRecords() });
  assert.equal(bar.paint(), '');
  assert.equal(bar.visible, false);
});

test('a bar with no screen still answers what it would paint', () => {
  const transcript = {
    lineRecords: () => [row('a prompt', 'user', '11:11:11')],
    childBase: 9,
    height: 10,
    iheight: 4,
    lpos: { yi: 0, xi: 0 },
    ileft: 1,
    itop: 1,
  };
  const bar = createStickyBar({ transcript, records: () => transcript.lineRecords() });
  assert.ok(bar.paint().includes('a prompt'));
  bar.close();
  assert.equal(bar.visible, false);
});

test('the pinned row carries no markup, only the prompt’s own characters', () => {
  // A quote is a symbolic palette tag in the record: `colorizeLine()` resolves it at paint
  // time for the transcript, and the pin never goes through that path, so it must be
  // stripped here. Left in, blessed does not know `@` as a tag character and prints
  // `{@quote-fg}` on screen as literal text — the reported bug.
  assert.equal(stickyText('{@quote-fg}│ hello quoted{/@quote-fg}', 40), '│ hello quoted');
  // A real blessed tag (a heading) and an escaped brace (a literal `{` the user typed).
  assert.equal(stickyText('{bold}{underline}a heading{/underline}{/bold}', 40), 'a heading');
  assert.equal(stickyText('a {open}x{close} b', 40), 'a {x} b');
  // A mixed line: both tag kinds around one literal brace pair.
  assert.equal(stickyText('{bold}{@quote-fg}│ a {open}x{close} b{/@quote-fg}{/bold}', 40), '│ a {x} b');
});

test('a markup-laden prompt is measured by its glyphs, not by its tags', () => {
  // `displayWidth()` charges every tag character as a visible cell, so a pin that measured
  // the tagged line would spend a dozen cells of its budget on bytes nobody sees and then
  // truncate the prompt to make room for them.
  const tagged = '{@quote-fg}│ hello quoted{/@quote-fg}';
  assert.equal(stickyText(tagged, 40), '│ hello quoted');
  assert.equal(stickyText(tagged, 40).length, '│ hello quoted'.length);
  // The tagged line is far wider than the prompt it contains: `displayWidth()` charges every
  // tag character as a visible cell. A budget between the two therefore holds the whole
  // prompt and could never have held the markup, which is the point being proven.
  const plain = displayWidth('│ hello quoted');
  assert.ok(displayWidth(tagged) > plain + 10, 'the markup is charged to the width');
  assert.ok(displayWidth(tagged) > 20 && plain < 20, 'and the budget sits between the two');
  assert.equal(stickyText(tagged, 20), '│ hello quoted', 'so the prompt fits whole in 20');
  assert.equal(displayWidth(stickyText(tagged, 10)), 10, 'a genuine cut still happens at the glyphs');
});

test('the real screen pins the prompt when the reader scrolls, and releases it at the top', async () => {
  await withTui(async (tui) => {
    const flush = async () => {
      for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };

    // A prompt, then enough agent output to push it off the top of the pane.
    tui.logProse('user', 'do the thing that takes a while');
    for (let i = 0; i < 60; i += 1) tui.logProse('assistant', `step ${i} of the long turn`);
    await flush();

    // Parked at the bottom the prompt is off screen, so the pin is up and carries the mark.
    assert.equal(tui.stickyVisible, true);
    assert.ok(tui.stickyLine.includes('do the thing'), tui.stickyLine);

    // Scrolled back to the very top the real row is visible, so the pin steps aside.
    tui.scrollPage(-1);
    for (let i = 0; i < 20 && tui.stickyVisible; i += 1) tui.scrollPage(-1);
    assert.equal(tui.stickyVisible, false);
  });
});

test('a wheel scroll releases the pin too, because the viewport binds the wheel itself', async () => {
  await withTui(async (tui) => {
    const flush = async () => {
      for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };

    tui.logProse('user', 'do the thing that takes a while');
    for (let i = 0; i < 60; i += 1) tui.logProse('assistant', `step ${i} of the long turn`);
    await flush();
    assert.equal(tui.stickyVisible, true, 'parked at the bottom the prompt is pinned');

    // The wheel is bound inside `createViewport()`, so it never passes through the view's
    // `scrollRows` wrapper. Telling the pin only from that wrapper left the pinned row on
    // screen while the real prompt was visibly back — the reported bug.
    for (let i = 0; i < 40 && tui.stickyVisible; i += 1) tui.transcript.emit('wheelup');
    await flush();
    assert.equal(tui.stickyVisible, false, 'the wheel released the pin with the real row');
  });
});

test('a quoted prompt pins its text, never the palette tag behind it', async () => {
  await withTui(async (tui) => {
    const flush = async () => {
      for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };

    // A quote is a symbolic palette tag in the record. The transcript resolves it at paint
    // time; the pin does not take that path, so left alone blessed prints `{@quote-fg}` on
    // screen as literal text — the reported bug, and why this case reads the *rendered*
    // frame rather than the bar's own string.
    tui.logProse('user', '> the quoted line');
    for (let i = 0; i < 60; i += 1) tui.logProse('assistant', `step ${i} of the long turn`);
    await flush();

    assert.equal(tui.stickyVisible, true);
    assert.doesNotMatch(tui.stickyLine, /@quote-fg/, 'the palette key is not in the pinned row');
    assert.match(tui.stickyLine, /│ the quoted line/, 'the quote bar is drawn as a character');

    tui.screen.render();
    const frame = [];
    for (let y = 0; y < tui.screen.rows; y += 1) {
      let row = '';
      for (let x = 0; x < tui.screen.cols; x += 1) {
        const cell = tui.screen.lines[y]?.[x];
        row += cell ? (cell[1] ?? ' ') : ' ';
      }
      frame.push(row);
    }
    const pinned = frame.find((line) => line.includes(STICKY_MARKER));
    assert.ok(pinned, 'the pin is on the rendered screen');
    assert.doesNotMatch(pinned, /\{[^}]*\}/, 'no brace survived to the screen');
  });
});