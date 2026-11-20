import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_HINT_CHARS,
  MAX_LINE_CHARS,
  compressBlankLines,
  expandTabs,
  hintFileText,
  hintSavings,
  truncateLine,
} from '../utils/file-hint.js';
import { execute as hintExecute } from '../tools/hint_file.js';
import { READ_ONLY_TOOLS, refusalForMode } from '../app/mode-policy.js';
import { toolFamily, toolColorFor } from '../app/tool-palette.js';
import { formatTranscript } from '../app/tui-render.js';

/**
 * Proof for the `hint_file` tool (docs/agent/file-hint): the pure sketch rules
 * (`utils/file-hint.js`), the paging and delimiter of the tool itself, and the two
 * registrations that decide where a hint may run and how it is painted.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-hint-test-'));
process.chdir(root);

function writeFile(name, content) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), content, 'utf-8');
}

/** The visible rows of a rendered transcript (blessed tags stripped). */
const visible = (text) => formatTranscript(text).replace(/\{[^}]+\}/g, '');

// ---------------------------------------------------------------------------
// the pure sketch rules
// ---------------------------------------------------------------------------

test('expandTabs aligns on an eight-column grid', () => {
  assert.equal(expandTabs('a\tb'), 'a       b');
  assert.equal(expandTabs('abcdefgh\ti'), 'abcdefgh        i');
  assert.equal(expandTabs('\tx'), '        x');
  // A line with no tab is returned untouched, and a nonsense width falls back.
  assert.equal(expandTabs('plain'), 'plain');
  assert.equal(expandTabs('a\tb', 0), 'a       b');
  assert.equal(expandTabs('ab\tc', 4), 'ab  c');
});

test('compressBlankLines collapses a run to one line and drops the edges', () => {
  assert.equal(compressBlankLines('a\n\n\n\nb'), 'a\n\nb');
  assert.equal(compressBlankLines('\n\na\n\n\n'), 'a');
  // Whitespace-only lines are blank lines, and CRLF is normalised first.
  assert.equal(compressBlankLines('a\n   \n\t\nb'), 'a\n\nb');
  assert.equal(compressBlankLines('a\r\n\r\n\r\nb'), 'a\n\nb');
  assert.equal(compressBlankLines(''), '');
  assert.equal(compressBlankLines('one line'), 'one line');
});

test('truncateLine keeps the head and reports the characters it dropped', () => {
  assert.equal(truncateLine('short', 10), 'short');
  assert.equal(truncateLine('abcdefghij', 4), 'abcd...[6 chars after]');
  assert.equal(truncateLine('x'.repeat(MAX_LINE_CHARS + 1)).endsWith('...[1 chars after]'), true);
  // A nonsense cap falls back to the documented default instead of cutting to nothing.
  assert.equal(truncateLine('abcdef', 0), 'abcdef');
});

test('hintFileText applies the steps in order and reports what it cut', () => {
  const raw = '\tconst a = 1;\n\n\n\nconst b = 2;\n' + 'y'.repeat(300) + '\n';
  const hint = hintFileText(raw);

  assert.equal(hint.truncated, true, 'a cut line is a truncated hint');
  assert.ok(!hint.text.includes('\t'), 'no tab survives');
  assert.ok(hint.text.includes('        const a = 1;'), 'the tab became spaces');
  assert.ok(!hint.text.includes('\n\n\n'), 'the blank run collapsed');
  assert.match(hint.text, /\.\.\.\[\d+ chars after\]/, 'the long line is marked');
  assert.equal(hint.droppedChars, 0, 'the whole document fits the budget');

  // The numbers the delimiter reports are the real ones.
  const savings = hintSavings(raw, hint.text);
  assert.equal(savings.before, raw.length);
  assert.equal(savings.after, hint.text.length);
  assert.ok(savings.savedChars > 0, 'a hint is smaller than its page');
});

test('hintFileText caps the whole hint on a line boundary', () => {
  const raw = Array.from({ length: 500 }, () => 'z'.repeat(40)).join('\n');
  const hint = hintFileText(raw, { maxChars: 200 });

  assert.equal(hint.truncated, true);
  assert.ok(hint.text.length <= 200 + 40, 'the budget holds, marker aside');
  assert.match(hint.text, /\n\.\.\.\[\d+ chars after\]$/, 'the cut is reported, at the end');
  assert.ok(hint.droppedChars > 0);
  assert.equal(raw.length - hint.text.length <= hint.droppedChars + 40, true);
  // A document inside the budget is returned without any marker at all.
  const small = hintFileText('a\nb', { maxChars: MAX_HINT_CHARS });
  assert.equal(small.truncated, false);
  assert.equal(small.text, 'a\nb');
});

// ---------------------------------------------------------------------------
// the tool
// ---------------------------------------------------------------------------

test('hint_file wraps a sketch in <hint> tags with the page coordinates', async () => {
  writeFile('app/sketchy.js', '\tconst a = 1;\n\n\n\n' + 'w'.repeat(400) + '\n');

  const result = await hintExecute({ path: './app/sketchy.js', intent: 'sketch it' });
  assert.match(result, /^<hint path="app\/sketchy\.js" from=1 to=\d+ lines=\d+ chars=\d+ of=\d+ truncated=true>\n/);
  assert.match(result, /\n<\/hint>$/);
  assert.ok(!result.includes('\t'), 'the tool never returns a tab');
  assert.match(result, /\.\.\.\[\d+ chars after\]/);

  const tag = result.split('\n')[0];
  const chars = Number(tag.match(/chars=(\d+)/)[1]);
  const of = Number(tag.match(/of=(\d+)/)[1]);
  assert.ok(chars < of, 'the sketch is smaller than the page it came from');
});

test('hint_file pages a file the way read_file does, negative offsets included', async () => {
  writeFile('paged.txt', Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n') + '\n');

  const paged = await hintExecute({ path: 'paged.txt', offset: 3, limit: 6, intent: 'hint the middle' });
  assert.match(paged, /^<hint path="paged\.txt" from=2 to=4 /);
  assert.ok(paged.includes('\nl2\nl3\n'), 'the same page read_file would return');

  const tail = await hintExecute({ path: 'paged.txt', offset: -4, intent: 'hint the end' });
  assert.match(tail, /^<hint path="paged\.txt" from=\d+ to=\d+ /);
  assert.ok(tail.includes('l10'), 'a negative offset counts from the end');

  // Line numbers are opt-in, because a hint is meant to be compact.
  const unnumbered = await hintExecute({ path: 'paged.txt', limit: 6, intent: 'hint it' });
  assert.ok(unnumbered.includes('\nl1\n'), 'no line numbers by default');
  const numbered = await hintExecute({ path: 'paged.txt', limit: 6, lineNumbers: true, intent: 'hint it numbered' });
  assert.ok(numbered.includes('     1  l1'), 'line numbers when asked for');
});

test('hint_file refuses an escaping path and reports a missing one', async () => {
  const escape = JSON.parse(await hintExecute({ path: '../outside.js', intent: 'try to escape' }));
  assert.equal(escape.status, 'error');
  assert.equal(escape.code, 'INVALID_PATH');
  assert.match(escape.guidance, /relative path inside the project/);

  const missing = JSON.parse(await hintExecute({ path: 'nope/absent.js', intent: 'read a ghost' }));
  assert.equal(missing.status, 'error');
  assert.equal(missing.code, 'NOT_FOUND');
  assert.match(missing.message, /hint_file failed/);
});

// ---------------------------------------------------------------------------
// where a hint may run, and how it is painted
// ---------------------------------------------------------------------------

test('hint_file is a read-only tool in the read family', () => {
  assert.ok(READ_ONLY_TOOLS.includes('hint_file'), 'a hint only reads');
  assert.equal(refusalForMode('chat', { name: 'hint_file', args: {} }), null, 'Chat may sketch');
  assert.equal(refusalForMode('design', { name: 'hint_file', args: {} }), null, 'Design may sketch');
  assert.equal(toolFamily('hint_file'), 'read');
  assert.equal(toolColorFor('hint_file'), 'bright-cyan');
});

test('the hint delimiter renders as a header, not raw text', () => {
  const body = [
    '<hint path="utils/a.js" from=1 to=2 lines=2/9 chars=40 of=99 truncated=true>',
    'const a = 1;',
    '</hint>',
  ].join('\n');
  const rows = visible(body).split('\n');

  assert.match(rows[0], /┌─ hint utils\/a\.js from=1 to=2 · lines=2\/9 · 40\/99 chars · truncated/);
  assert.match(rows[2], /└─+/);
  assert.doesNotMatch(visible(body), /<hint |<\/hint>/);
});
