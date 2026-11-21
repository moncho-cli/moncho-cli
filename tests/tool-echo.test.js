import test from 'node:test';
import assert from 'node:assert/strict';

import { createToolEcho } from '../app/tool-echo.js';
import { prettyPrintJson } from '../app/json-display.js';

/**
 * How a tool result reaches the screen (`docs/interface/json-display`).
 *
 * The invariant `main.js` depends on: the TUI gets one collapsible block carrying the call's
 * intent and the pretty-printed body, while the line CLI gets the same three lines plainly.
 * The bytes shown are the display form — the model's raw result is untouched.
 */

test('createToolEcho() paints a tool result in the pane, or as plain lines without a screen', () => {
  const raw = JSON.stringify({ ok: true, files: ['a.js', 'b.js'] });

  // The TUI: one block, header first, body pretty-printed.
  const blocks = [];
  const echoTui = createToolEcho({ tui: { logBlock: (block) => blocks.push(block) } });
  echoTui('run_bash', raw, 'list the files');

  assert.equal(blocks.length, 1, 'one block per tool result');
  assert.match(blocks[0].header, /\[run_bash Output\]/);
  assert.match(blocks[0].header, /intent: list the files/, 'the intent rides the header');
  assert.equal(blocks[0].body, prettyPrintJson(raw), 'the body is the display form');
  assert.match(blocks[0].body, /\n {2}"ok": true/, 'and it is indented');

  // The line CLI: the same header and body, printed plainly, with a blank line after.
  const lines = [];
  const echoCli = createToolEcho({ tui: null, log: (line) => lines.push(line) });
  echoCli('read_file', raw);

  assert.equal(lines.length, 3, 'header, body, blank line');
  assert.match(lines[0], /\[read_file Output\]/);
  assert.doesNotMatch(lines[0], /intent:/, 'a call with no intent says nothing extra');
  assert.equal(lines[1], prettyPrintJson(raw));
  assert.equal(lines[2], '', 'the blank line separates two results');
});

test('a result that is not JSON is passed through the same way', () => {
  const blocks = [];
  createToolEcho({ tui: { logBlock: (block) => blocks.push(block) } })('read_file', 'plain prose');
  assert.equal(blocks[0].body, 'plain prose', 'prose is not reformatted');

  const lines = [];
  createToolEcho({ tui: null, log: (line) => lines.push(line) })('read_file', 'plain prose');
  assert.deepEqual(lines.slice(0, 2), ['\n  [read_file Output]', 'plain prose']);
});
