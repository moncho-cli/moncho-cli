import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONVERSATION_COLORS,
  classifyLine,
  colorizeLine,
  colorizeLines,
  isTagged,
} from '../app/theme.js';
import { formatTranscript, formatUserEcho } from '../app/tui-render.js';
import { withTui, visible, plainText } from './support/tui-harness.js';

/**
 * The conversation palette (task-backlog: "conversation needs colors to be easier
 * to read").
 *
 * Two halves, both proven here:
 *  - the *classification* is pure text work (`classifyLine`/`colorizeLine`), and
 *  - the *transcript* really carries the colour to the terminal, while every line
 *    the markdown renderer already coloured keeps its own colour and the visible
 *    glyphs stay byte-identical (which is what the block-click math relies on).
 *
 * Colour is presentation only, so the cases also check that no tag can reach the
 * text the model receives or a session file.
 */

const flush = async (rounds = 3) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('the palette names one colour per kind of conversation row', () => {
  assert.deepEqual(Object.keys(CONVERSATION_COLORS).sort(), [
    'context', 'error', 'notice', 'tool', 'user',
  ]);
  for (const [kind, color] of Object.entries(CONVERSATION_COLORS)) {
    assert.match(color, /^[a-z]+$/, `${kind} names a plain blessed colour`);
  }
  // the four parts of a turn must not share a colour
  const used = Object.values(CONVERSATION_COLORS);
  assert.equal(new Set(used).size, used.length, 'each kind gets its own colour');
});

test('classifyLine() tells the parts of a turn apart and leaves prose alone', () => {
  // the user's own message
  assert.equal(classifyLine('You:'), 'user');
  assert.equal(classifyLine('You are wrong about this'), null, 'only the exact header');

  // tool calls and their results
  assert.equal(classifyLine('  -> Calling read_file(path: app/tui.js)'), 'tool');
  assert.equal(classifyLine('     intent: read the file to check the layout'), 'tool');
  assert.equal(classifyLine('  [read_file Output] (intent: read it)'), 'tool');
  assert.equal(classifyLine('\n  [run_bash Output]'), 'tool', 'main.js prefixes the header with a newline');
  assert.equal(classifyLine('▸   [read_file Output] — 40 char response (click to expand)'), 'tool');

  // context and chrome
  assert.equal(classifyLine('[Context] 1.2k / 8.0k tokens (15%)'), 'context');
  assert.equal(classifyLine('[Context] compaction fired: 4 older chunk(s)'), 'context');
  assert.equal(classifyLine('[Info] Task cancelled by user.'), 'notice');
  assert.equal(classifyLine('[Session] Could not save agent/sessions/x.json'), 'notice');
  assert.equal(classifyLine('[pasted 12 lines -> [[paste:0]]]'), 'notice');
  assert.equal(classifyLine('--- AI Response ---'), 'notice');
  assert.equal(classifyLine('----------------------'), 'notice');

  // errors win over the tool/notice shapes they may also have
  assert.equal(classifyLine('Error calling Ollama: connect ECONNREFUSED'), 'error');
  assert.equal(classifyLine('Error: Received null/empty API response. Retrying...'), 'error');
  assert.equal(classifyLine('[error] exit code 1'), 'error');
  assert.equal(classifyLine('  [read_file Output] ⚠️ file not found'), 'error');

  // ordinary prose gets no colour: the terminal default and the markdown
  // renderer are enough for it
  assert.equal(classifyLine('Here is what I found in the file:'), null);
  assert.equal(classifyLine(''), null);
  assert.equal(classifyLine('   '), null);
  assert.equal(classifyLine(undefined), null);
});

test('a line the markdown renderer already coloured is left untouched', () => {
  // fences, delimiters, quotes, headings, lists and inline code all arrive as
  // tagged lines: the palette must not wrap them again
  const alreadyTagged = [
    '{cyan-fg}┌─ js ─{/cyan-fg}',
    '{cyan-fg}│ const a = {open} b: 1 {close};{/cyan-fg}',
    '{cyan-fg}┌─ app/tui.js from=1 to=3 · lines=3{/cyan-fg}',
    '{green-fg}│ quoted line{/green-fg}',
    '{green-fg}•{/green-fg} first item',
    '{bold}{underline}Title{/underline}{/bold}',
  ];
  for (const line of alreadyTagged) {
    assert.equal(isTagged(line), true);
    assert.equal(classifyLine(line), null);
    assert.equal(colorizeLine(line), line, 'the existing colour survives');
  }

  // a tool-call line with inline markup keeps its inner tags and gains the tool
  // colour around them (blessed restores the outer colour after the inner close)
  assert.equal(
    colorizeLine('  -> Calling read_file(path: **x**)'),
    '{yellow-fg}  -> Calling read_file(path: **x**){/yellow-fg}',
  );
});

test('colorizeLine()/colorizeLines() wrap a line without rewriting it', () => {
  assert.equal(colorizeLine('You:'), `{${CONVERSATION_COLORS.user}-fg}You:{/${CONVERSATION_COLORS.user}-fg}`);
  assert.equal(colorizeLine('plain prose'), 'plain prose', 'prose is returned verbatim');

  const lines = ['You:', 'plain', '[Context] 1.2k / 8.0k tokens'];
  const coloured = colorizeLines(lines);
  assert.equal(coloured.length, lines.length, 'one output line per input line');
  assert.equal(coloured[1], 'plain');
  for (const [index, line] of coloured.entries()) {
    // stripping the tags returns the original line byte-for-byte
    assert.equal(line.replace(/\{[^}]+\}/g, ''), lines[index].replace(/\{[^}]+\}/g, ''));
  }
  assert.deepEqual(colorizeLines(), []);
});

test('formatTranscript() colours the parts of a turn and keeps the markdown colours', () => {
  const rendered = formatTranscript([
    'You:',
    '> what does the layout do?',
    '  -> Calling read_file(path: app/tui-layout.js)',
    '     intent: check the region anchors',
    '  [read_file Output] (intent: check the region anchors)',
    '[Context] 1.2k / 8.0k tokens (15%)',
    'Error calling Ollama: connect ECONNREFUSED',
    'plain assistant prose',
  ].join('\n')).split('\n');

  assert.equal(rendered[0], '{cyan-fg}You:{/cyan-fg}', 'the echo header is the user colour');
  assert.equal(rendered[1], '{green-fg}│ what does the layout do?{/green-fg}', 'the quoted message keeps its markdown colour');
  assert.equal(rendered[2], '{yellow-fg}  -> Calling read_file(path: app/tui-layout.js){/yellow-fg}');
  assert.equal(rendered[3], '{yellow-fg}     intent: check the region anchors{/yellow-fg}');
  assert.equal(rendered[4], '{yellow-fg}  [read_file Output] (intent: check the region anchors){/yellow-fg}');
  assert.equal(rendered[5], '{magenta-fg}[Context] 1.2k / 8.0k tokens (15%){/magenta-fg}');
  assert.equal(rendered[6], '{red-fg}Error calling Ollama: connect ECONNREFUSED{/red-fg}');
  assert.equal(rendered[7], 'plain assistant prose', 'prose is untouched');

  // the existing markdown rules are unchanged
  assert.equal(formatTranscript('`code`'), '{cyan-fg}code{/cyan-fg}');
  assert.equal(formatTranscript('**bold**'), '{bold}bold{/bold}');
  assert.equal(formatTranscript('# Title'), '{bold}{underline}Title{/underline}{/bold}');
});

test('the colour reaches the terminal, and the visible glyphs are unchanged', async () => {
  await withTui(async (tui, { painted }) => {
    tui.log(formatUserEcho('hello there'));
    tui.log('  -> Calling read_file(path: app/tui.js)');
    tui.log('[Context] 1.2k / 8.0k tokens (15%)');
    tui.log('Error calling Ollama: connect ECONNREFUSED');
    await flush();

    const frame = painted();
    // 36 = cyan, 33 = yellow, 35 = magenta, 31 = red
    const cyan = frame.indexOf('You:');
    const yellow = frame.indexOf('Calling read_file');
    const magenta = frame.indexOf('[Context] 1.2k');
    const red = frame.indexOf('Error calling Ollama');
    assert.ok(cyan >= 0 && yellow >= 0 && magenta >= 0 && red >= 0, 'every row was painted');

    assert.match(frame.slice(Math.max(0, cyan - 20), cyan), /\x1b\[36m/, 'the echo header is cyan');
    assert.match(frame.slice(Math.max(0, yellow - 20), yellow), /\x1b\[33m/, 'the tool call is yellow');
    assert.match(frame.slice(Math.max(0, magenta - 20), magenta), /\x1b\[35m/, 'the context notice is magenta');
    assert.match(frame.slice(Math.max(0, red - 20), red), /\x1b\[31m/, 'the error is red');

    // ... and the palette never changes a glyph: the same text is visible
    const text = visible(tui);
    assert.match(text, /You:/);
    assert.match(text, /│ hello there/);
    assert.match(text, /Calling read_file\(path: app\/tui\.js\)/);
    assert.match(text, /\[Context\] 1\.2k \/ 8\.0k tokens \(15%\)/);
    assert.match(text, /Error calling Ollama: connect ECONNREFUSED/);
    assert.doesNotMatch(text, /-fg\}/, 'no blessed tag leaks as text');
    assert.doesNotMatch(plainText(frame), /-fg\}/);
  });
});

test('a coloured block header still toggles on the same row', async () => {
  await withTui(async (tui) => {
    // the header main.js builds for a tool result; the palette colours its label
    const block = tui.logBlock({ header: '\n  [read_file Output] (intent: read it)', body: 'a\nb\nc' });
    await flush();

    assert.match(visible(tui), /\[read_file Output\] \(intent: read it\)/);
    assert.match(visible(tui), /5 char response/);
    assert.equal(block.collapsed, true);

    // the click math reads display lines, and the tag adds no visible width: the
    // block is still reachable on the row it paints
    const range = tui.transcriptModel.rangeOf(block);
    assert.equal(range.end - range.start, 1, 'a collapsed block is one row');
    assert.equal(tui.clickTranscript({
      x: tui.transcript.lpos.xi + 2,
      y: tui.transcript.lpos.yi + tui.transcript.itop + range.start,
    }), block);
    assert.equal(block.collapsed, false);
  });
});

test('colour is presentation only: the model text carries no tag', () => {
  // formatUserEcho is what main.js hands the front end, and its header/prefix are
  // plain text: the tags are added by the renderer, never by the echo itself
  assert.equal(formatUserEcho('one line'), 'You:\n> one line');
  assert.doesNotMatch(formatUserEcho('one line'), /-fg\}/);

  // the chunk ConversationManager stores is the prompt itself; the palette only
  // ever runs inside formatTranscript(), which the line CLI never calls
  const rendered = formatTranscript('You:\n> a prompt');
  assert.match(rendered, /\{cyan-fg\}You:\{\/cyan-fg\}/);
  assert.equal(rendered.replace(/\{[^}]+\}/g, ''), 'You:\n│ a prompt');
});
