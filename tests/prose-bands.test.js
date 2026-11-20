import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROSE_BANDS,
  BAND_BACKGROUNDS,
  isBandRole,
  bandColor,
  bandLine,
  bandMargin,
} from '../app/prose-band.js';
import { padVisible, visibleWidth, untag } from '../app/tagged-text.js';
import { STAMP_RE } from '../app/transcript-stamp.js';
import { TranscriptModel } from '../app/transcript.js';
import { appendLines } from '../app/transcript-append.js';
import { formatTranscript, formatUserEcho } from '../app/tui-render.js';
import { withTui, visible, plainText } from './support/tui-harness.js';

/**
 * The background bands around the two sides of the dialogue (task-backlog: "both user
 * message and model prose chunks in the TUI should have like a nice background
 * (different color for each) with 1 line margin top and bottom").
 *
 * Two halves, both proven here: the *pure* rules (the two colours, the fill and the
 * one-line margin) and the real widget, where the band really paints a full-width
 * background and where the visible glyphs — which the block-click math depends on —
 * stay byte-identical.
 *
 * The band is presentation only, so the cases also check that no escape can reach the
 * text the model receives or a session file, and that a front end without a band (the
 * line CLI) prints exactly what it always did.
 */

const flush = async (rounds = 3) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * A display line with its `HH:MM:SS ` stamp and its palette tags removed: the visible
 * text only. The live TUI always marks a stamp, so an expectation has to see past it.
 */
const bare = (text) => untag(String(text).replace(STAMP_RE, ''));

test('the two sides of the dialogue get one background colour each, and nothing else does', () => {
  // exactly two sides, each with its own colour, and the colours differ
  assert.deepEqual([...PROSE_BANDS], ['user', 'assistant']);
  assert.deepEqual(Object.keys(BAND_BACKGROUNDS).sort(), ['assistant', 'user']);
  assert.notEqual(BAND_BACKGROUNDS.user, BAND_BACKGROUNDS.assistant, 'the two sides never read alike');
  for (const [role, color] of Object.entries(BAND_BACKGROUNDS)) {
    assert.match(color, /^[a-z-]+$/, `${role} names a plain blessed colour`);
  }

  // only the two sides are banded; every other role is refused, never guessed
  assert.equal(isBandRole('user'), true);
  assert.equal(isBandRole('assistant'), true);
  assert.equal(bandColor('user'), BAND_BACKGROUNDS.user);
  for (const other of ['tool', 'notice', 'error', 'context', '', null, undefined, 'system']) {
    assert.equal(isBandRole(other), false, `${other} is not a side of the dialogue`);
    assert.equal(bandColor(other), null);
  }
});

test('bandLine() pads a line to the region width and leaves a bandless role untouched', () => {
  // the band is padded *inside* the tag, so the whole row is coloured even where
  // there is no text — which is what the one-line margin is made of
  assert.equal(bandLine('hi', 'user', 6), '{blue-bg}hi    {/blue-bg}');
  assert.equal(bandMargin('assistant', 4), '{red-bg}    {/red-bg}');

  // a role with no band comes back byte-for-byte, so the rule is safe on every row
  const tagged = '{cyan-fg}┌─ js ─{/cyan-fg}';
  assert.equal(bandLine(tagged, null, 20), tagged);
  assert.equal(bandLine(tagged, 'tool', 20), tagged);

  // a line already wider than the region is left for blessed to wrap, never cut
  assert.equal(bandLine('a long line', 'user', 3), '{blue-bg}a long line{/blue-bg}');

  // the width is counted in cells and the tags are never charged for
  assert.equal(visibleWidth('{bold}hi{/bold}'), 2);
  assert.equal(untag('a{open} b'), 'a{ b');
  assert.equal(padVisible('{bold}hi{/bold}', 5), '{bold}hi{/bold}   ');
  // a wide glyph covers two cells, so a band of the same width pads it one space less
  assert.equal(padVisible('日', 4), '日  ');
  assert.equal(visibleWidth(padVisible('日', 4)), 4);
});

test('the transcript model records the side of each entry, and a margin is a blank banded row', () => {
  const model = new TranscriptModel();
  model.addLine('{blue-bg} {/blue-bg}', { role: 'user' });
  model.addLine('{blue-bg}hi{/blue-bg}', { role: 'user' });
  model.addLine('plain prose');
  model.addLine('{red-bg}answered{/red-bg}', { role: 'assistant' });
  model.addBlock({ header: 'a result', body: 'x' });

  const records = model.lineRecords();
  // only the two sides carry a role; the plain line and the block carry none
  assert.deepEqual(records.map((r) => r.role), ['user', 'user', null, 'assistant', null, null]);
  // `lines` stays the plain string array every earlier caller expects, and it agrees
  // with the records byte-for-byte
  assert.deepEqual(model.lines, records.map((r) => r.text));

  // a block carries its marker on the header line only, exactly like `lines` says
  const block = model.blocks[0];
  const range = model.rangeOf(block);
  assert.equal(records[range.start].text, model.lines[range.start]);
  assert.equal(records[range.start + 1].text, model.lines[range.start + 1]);
});

test('the real widget paints the two backgrounds, keeps the glyphs, and pads to its own width', async () => {
  await withTui(async (tui) => {
    tui.logProse('user', formatUserEcho('what does the layout do?'));
    tui.logProse('assistant', 'It lays out seven regions.');
    await flush();

    const content = tui.transcript.getContent();
    // user side: blue background (44); assistant side: dark red (41)
    const userAt = content.indexOf('You:');
    const assistantAt = content.indexOf('seven regions');
    assert.ok(userAt >= 0 && assistantAt >= 0, 'both sides are on screen');
    assert.match(content.slice(0, userAt), /\x1b\[44m/, 'the user side is painted on a blue band');
    assert.match(content.slice(0, assistantAt), /\x1b\[41m/, 'the assistant side is painted on a dark red band');

    // the visible glyphs are exactly what they were: colour adds no character
    const text = visible(tui);
    assert.match(text, /You:/);
    assert.match(text, /│ what does the layout do\?/);
    assert.match(text, /It lays out seven regions\./);
    assert.doesNotMatch(text, /-bg\}/, 'no blessed tag leaks as text');
    assert.doesNotMatch(plainText(tui.transcript._pcontent ?? ''), /-bg\}/);

    // the band is padded to blessed's own wrap width, so it never wraps into a second
    // row and shifts everything below it
    const rows = tui.transcript._clines.length;
    assert.equal(rows, tui.transcriptModel.lineRecords().length, 'one painted row per display line');
  });
});

test('appendLines() adds the margins and stamps the first non-blank line', () => {
  const model = new TranscriptModel();
  const stamp = () => '01:02:03';

  // a banded group opens and closes with a blank banded row
  appendLines(model, ['one', 'two'], { role: 'user', mark: stamp });
  assert.deepEqual(model.lineRecords().map((r) => `${r.role}:${r.text}`), [
    'user:', 'user:01:02:03 one', 'user:two', 'user:',
  ]);

  // a second band shares the margin already there: no double blank row, and each
  // group is one entry, so it is stamped once on its own first line
  appendLines(model, ['three'], { role: 'assistant', mark: stamp });
  assert.deepEqual(model.lineRecords().map((r) => `${r.role}:${r.text}`), [
    'user:', 'user:01:02:03 one', 'user:two', 'user:',
    'assistant:01:02:03 three', 'assistant:',
  ]);

  // a plain (unbanded) group is exactly what it always was: no margin, no role
  appendLines(model, ['plain'], { mark: stamp });
  const last = model.lineRecords().at(-1);
  assert.equal(last.role, null);
  assert.equal(last.text, '01:02:03 plain', 'the stamp goes on a plain line too, at its start');

  // an entry that opens with a blank line is stamped where its text really starts
  appendLines(model, ['', 'starts here'], {});
  const tail = model.lineRecords().slice(-2);
  assert.equal(tail[0].text, '');
  assert.equal(tail[1].text, 'starts here');

  assert.equal(appendLines(null, ['x']), 0, 'no model is a no-op');
});

test('a banded line paints a full-width background with one blank banded row above and below', async () => {
  await withTui(async (tui) => {
    tui.logProse('user', formatUserEcho('a prompt'));
    await flush();

    // the margin, the echo's two rows (`You:` and the quote), the margin
    const records = tui.transcriptModel.lineRecords();
    assert.deepEqual(records.map((r) => bare(r.text)), ['', 'You:', '│ a prompt', '']);
    for (const record of records) {
      assert.equal(record.role, 'user', 'the margins belong to the same side as the band');
    }

    // ...and the blank rows really carry the background, which is what makes them read
    // as part of the block rather than as a gap in the transcript
    const lines = tui.transcript._clines.map((line) => bare(line.replace(/\x1b\[[\d;]*m/g, '')));
    assert.deepEqual(lines.map((line) => line.trim()), ['', 'You:', '│ a prompt', '']);
    for (const line of tui.transcript._clines) {
      assert.match(line, /\x1b\[44m/, 'every row of the block is banded');
    }
  });
});

test('two bands that meet share one blank row, so the margins never double up', async () => {
  await withTui(async (tui) => {
    tui.logProse('user', 'one');
    tui.logProse('assistant', 'two');
    await flush();

    const records = tui.transcriptModel.lineRecords();
    // user margin, one, user margin ... the assistant's top margin *is* that row
    assert.deepEqual(records.map((r) => `${r.role}:${bare(r.text)}`), [
      'user:', 'user:one', 'user:',
      'assistant:two', 'assistant:',
    ]);
  });
});

test('only the two sides are banded: a notice, a tool header and prose are not', async () => {
  await withTui(async (tui) => {
    tui.log('plain assistant prose with no band');
    tui.log('[Context] 1.2k / 8.0k tokens (15%)');
    tui.logBlock({ header: '\n  [read_file Output]', body: 'x' });
    await flush();

    const content = tui.transcript.getContent();
    assert.doesNotMatch(content, /-bg\}/, 'nothing without a band is wrapped');
    assert.doesNotMatch(content, /\x1b\[44m|\x1b\[41m/, 'no background was painted');
  });
});

test('the band is presentation only: the model text and the echo carry no escape', () => {
  // formatUserEcho is what main.js hands the prose route, and its header/prefix stay
  // plain text: the band is added by the view, never by the echo itself
  assert.equal(formatUserEcho('one line'), 'You:\n> one line');
  assert.doesNotMatch(formatUserEcho('one line'), /-bg\}/);

  // the transcript renderer never produces a band either: it colours structure only
  const rendered = formatTranscript('You:\n> a prompt');
  assert.doesNotMatch(rendered, /-bg\}/);
});

test('the band never changes the block-click math: a coloured block still toggles', async () => {
  await withTui(async (tui) => {
    tui.logProse('assistant', 'here is the result');
    const block = tui.logBlock({ header: '\n  [read_file Output]', body: 'a\nb\nc' });
    await flush(5);

    // the click path resolves through the model's line ranges, and a band adds no
    // display line of its own beyond the two margins it declares
    const range = tui.transcriptModel.rangeOf(block);
    assert.equal(range.end - range.start, 1, 'a collapsed block is one row');
    assert.equal(tui.clickTranscript({
      x: tui.transcript.lpos.xi + 2,
      y: tui.transcript.lpos.yi + tui.transcript.itop + range.start,
    }), block);
    assert.equal(block.collapsed, false);
  });
});
