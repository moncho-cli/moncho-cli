import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitize,
  formatArg,
  formatTranscript,
  collapsePaste,
  expandPastes,
} from '../app/tui.js';
import { withTui, plainText, visible } from './support/tui-harness.js';

/**
 * The pure text helpers of the TUI (app/tui-render.js), split out of
 * tests/tui.test.js so each suite keeps one responsibility: the screen wiring is
 * proven there, the rendering rules here.
 */

test('sanitize() and formatArg() behave as documented', () => {
  assert.equal(sanitize('\x1b[1mhi\x1b[0m'), 'hi');
  assert.equal(sanitize(null), '');
  assert.equal(formatArg('x'), 'x');
  assert.equal(formatArg(3), '3');
  assert.equal(formatArg(null), 'null');
  assert.equal(formatArg(undefined), 'undefined');
  assert.equal(formatArg({ a: 1 }), '{"a":1}');
});

test('assistant replies are rendered with markdown coloring', async () => {
  const reply = [
    '# Title',
    'some **bold** and `code`',
    '- first item',
    '* second item',
    '```js',
    'const a = { b: 1 };',
    '```',
  ].join('\n');

  const rendered = formatTranscript(reply).split('\n');
  assert.equal(rendered[0], '{bold}{underline}Title{/underline}{/bold}');
  assert.equal(rendered[1], 'some {bold}bold{/bold} and {cyan-fg}code{/cyan-fg}');
  assert.equal(rendered[2], '{green-fg}•{/green-fg} first item');
  assert.equal(rendered[3], '{green-fg}•{/green-fg} second item');
  assert.equal(rendered[4], '{cyan-fg}┌─ js ─{/cyan-fg}');
  // braces inside a fence are escaped so neo-blessed cannot eat them
  assert.equal(rendered[5], '{cyan-fg}│ const a = {open} b: 1 {close};{/cyan-fg}');
  assert.equal(rendered[6], '{cyan-fg}└─────{/cyan-fg}');

  // an unterminated fence is closed at the end of the input
  assert.equal(formatTranscript('```\nstill code').split('\n').at(-1), '{cyan-fg}└─────{/cyan-fg}');

  // raw ansi and braces from the model cannot smuggle tags through
  assert.equal(formatTranscript('\x1b[31m{red-fg}x'), '{open}red-fg{close}x');

  await withTui((tui) => {
    tui.log(reply);
    // getContent() returns the painted lines with the blessed tags already
    // resolved to ANSI escapes, so strip them and assert on the visible glyphs.
    const content = visible(tui);
    assert.match(content, /┌─ js ─/);
    assert.match(content, /bold/);
    assert.match(content, /•/);
    assert.match(content, /│ const a = \{ b: 1 \};/);
    assert.equal(content.split('\n').filter((line) => line.includes('│')).length, 1);
  });
});

test('a long paste collapses to a paste tag and expands back byte-for-byte', async () => {
  const original = 'line 1\nline 2\nline 3\nline 4\nline 5';
  const collapsed = collapsePaste(original);
  assert.equal(collapsed.text, '[[paste:0]]');
  assert.deepEqual(collapsed.pastes, [original]);
  assert.equal(expandPastes(collapsed.text, collapsed.pastes), original);

  const short = collapsePaste('a\nb');
  assert.equal(short.text, 'a\nb');
  assert.deepEqual(short.pastes, []);

  const crlf = 'a\r\nb\r\nc\r\nd\r\ne\r\n';
  const crlfCollapsed = collapsePaste(crlf);
  assert.equal(expandPastes(crlfCollapsed.text, crlfCollapsed.pastes), crlf);
  assert.ok(expandPastes(crlfCollapsed.text, crlfCollapsed.pastes).endsWith('\r\n'));

  assert.equal(expandPastes('[[paste:9]]', []), '[[paste:9]]');

  await withTui(async (tui) => {
    const answered = tui.question('> ');
    tui.inputBox.setValue(original);
    tui.inputBox.emit('submit', original);
    assert.equal(await answered, original);
    assert.deepEqual(tui.pastes, [original]);
    assert.equal(tui.expandPastes('[[paste:0]]'), original);
    assert.match(visible(tui), /pasted 5 lines/);
  });
});

test('the read_file result tag renders as a header, not raw text', async () => {
  const tag = '<file relative_path="app/tui.js" from=10 to=40 lines=31>';
  const result = [tag, 'const a = 1;', '</file>'].join('\n');

  // formatTranscript() frames the delimiters instead of printing them raw
  const rendered = formatTranscript(result).split('\n');
  assert.equal(rendered[0], '{cyan-fg}┌─ app/tui.js from=10 to=40 · lines=31{/cyan-fg}');
  assert.equal(rendered[2], '{cyan-fg}└─────{/cyan-fg}');
  assert.doesNotMatch(formatTranscript(result), /<file relative_path/);

  // and the raw tag never reaches the painted transcript
  await withTui(async (tui, { painted }) => {
    tui.log(result);
    await new Promise((resolve) => setImmediate(resolve));
    assert.doesNotMatch(visible(tui), /<file relative_path/);
    assert.match(plainText(painted()), /┌─ app\/tui\.js from=10 to=40 · lines=31/);
  });
});

test('the grep and blob result tags render as headers, not raw text', async () => {
  const grepResult = [
    '<grep pattern="needle" path="." matches=2 files=2 truncated=true>',
    'app/alpha.js:2: // needle here',
    '</grep>'
  ].join('\n');
  const blobResult = [
    '<blobs path="utils" count=2 bytes=120 truncated=true>',
    '<blob path="utils/a.js" bytes=60 lines=4>',
    'const a = 1;',
    '</blob>',
    '<blob path="utils/bin.dat" skipped="binary-or-too-large" />',
    '</blobs>'
  ].join('\n');

  const renderedGrep = formatTranscript(grepResult).split('\n');
  assert.equal(renderedGrep[0], '{cyan-fg}┌─ grep /needle/ in . · 2 matches in 2 files · truncated{/cyan-fg}');
  assert.equal(renderedGrep[2], '{cyan-fg}└─────{/cyan-fg}');
  assert.doesNotMatch(formatTranscript(grepResult), /<grep /);

  const renderedBlob = formatTranscript(blobResult).split('\n');
  assert.equal(renderedBlob[0], '{cyan-fg}┌─ blobs utils · 2 files · 120 bytes · truncated{/cyan-fg}');
  assert.equal(renderedBlob[1], '{cyan-fg}├─ utils/a.js · 4 lines · 60 bytes{/cyan-fg}');
  assert.equal(renderedBlob[4], '{cyan-fg}├─ utils/bin.dat · skipped (binary-or-too-large){/cyan-fg}');
  assert.doesNotMatch(formatTranscript(blobResult), /<blobs |<blob /);

  await withTui(async (tui, { painted }) => {
    tui.log(grepResult);
    tui.log(blobResult);
    await new Promise((resolve) => setImmediate(resolve));
    assert.doesNotMatch(visible(tui), /<grep |<blobs |<blob /);
    assert.match(plainText(painted()), /┌─ grep \/needle\/ in \./);
  });
});
