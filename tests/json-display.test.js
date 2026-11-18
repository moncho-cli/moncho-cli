import test from 'node:test';
import assert from 'node:assert/strict';

import {
  looksLikeJson,
  prettyPrintJson,
  payloadOf,
  formatCommandResult,
} from '../app/json-display.js';
import { withTui, visible } from './support/tui-harness.js';

const OBJECT = { ok: true, code: 'LISTED', sessions: [{ id: 'a', chunks: 3 }] };

test('prettyPrintJson() re-indents a JSON object and leaves prose alone', () => {
  const pretty = prettyPrintJson(JSON.stringify(OBJECT));
  assert.equal(pretty, JSON.stringify(OBJECT, null, 2));
  assert.ok(pretty.includes('\n  "ok": true'), 'the object is indented');
  assert.ok(pretty.split('\n').length > 1, 'the result is multi-line');

  // an object argument is serialised the same way
  assert.equal(prettyPrintJson(OBJECT), JSON.stringify(OBJECT, null, 2));

  // anything that is not a JSON object/array is returned byte-for-byte
  for (const text of ['prose, not json', '42', '"a string"', 'null', '{broken']) {
    assert.equal(prettyPrintJson(text), text);
  }
  assert.equal(prettyPrintJson(undefined), 'undefined');
  assert.equal(prettyPrintJson(null), 'null');

  // the indent width is configurable and junk falls back to 2
  assert.equal(prettyPrintJson({ a: 1 }, { indent: 4 }), '{\n    "a": 1\n}');
  assert.equal(prettyPrintJson({ a: 1 }, { indent: -1 }), '{\n  "a": 1\n}');
});

test('looksLikeJson() only accepts objects and arrays', () => {
  assert.equal(looksLikeJson('{"a":1}'), true);
  assert.equal(looksLikeJson('  [1,2]  '), true);
  assert.equal(looksLikeJson('{"a":'), false);
  assert.equal(looksLikeJson('plain text'), false);
  assert.equal(looksLikeJson('42'), false);
  assert.equal(looksLikeJson(''), false);
});

test('payloadOf() drops the presentation keys and keeps the data', () => {
  const payload = payloadOf({ ok: true, code: 'LISTED', message: 'hi', lines: ['x'], sessions: [1] });
  assert.deepEqual(payload, { sessions: [1] });
  assert.equal(payloadOf({ ok: true, code: 'HELP', lines: ['/help'] }), null, 'nothing to print');
  assert.equal(payloadOf(null), null);
  assert.equal(payloadOf('text'), null);
});

test('formatCommandResult() prints the lines and the message, pretty-printing JSON', () => {
  const lines = formatCommandResult({
    ok: true,
    code: 'LISTED',
    lines: ['first', JSON.stringify({ a: 1 })],
    message: 'done',
  });

  assert.equal(lines[0], 'first');
  assert.deepEqual(lines.slice(1, 4), ['{', '  "a": 1', '}']);
  assert.equal(lines.at(-1), 'done', 'the message comes last');
});

test('a command result with only a payload is printed as pretty JSON', () => {
  const lines = formatCommandResult({ ok: true, code: 'LISTED', sessions: [{ id: 'a' }] });
  assert.deepEqual(lines, [
    '{',
    '  "sessions": [',
    '    {',
    '      "id": "a"',
    '    }',
    '  ]',
    '}',
  ]);

  // nulls and empty results print nothing at all
  assert.deepEqual(formatCommandResult(null), []);
  assert.deepEqual(formatCommandResult({ ok: true, code: 'CANCELLED' }), []);
  assert.deepEqual(formatCommandResult('prose'), ['prose']);
});

test('a tool result is pretty-printed for display, not for the model', async () => {
  await withTui(async (tui) => {
    const raw = JSON.stringify({ ok: true, files: ['a.js', 'b.js'] });
    const block = tui.logBlock({ header: '  [run_bash Output]', body: prettyPrintJson(raw) });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(block.collapsed, true, 'a multi-line JSON payload starts collapsed');
    assert.equal(block.chars, prettyPrintJson(raw).length);

    tui.expandBlock(block.id);
    const content = visible(tui);
    assert.match(content, /"files": \[/, 'the payload is indented when expanded');
    assert.match(content, /"a\.js"/);
    assert.doesNotMatch(content, /\{"ok":true/, 'the single-line form is gone');
  });
});
