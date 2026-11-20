import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  windowCaptured,
  renderCommandOutput,
  DEFAULT_WINDOW_LINES,
  CAPTURE_HINT,
  OUTPUT_DELIMITER
} from '../utils/command-output.js';
import { getCapture, clearCaptures } from '../utils/capture-store.js';
import { execute as runBashExecute } from '../tools/run_bash.js';
import { npmFailure } from '../tools/run_npm.js';
import { execute as readCaptureExecute } from '../tools/read_capture.js';

/**
 * The bounded default and the way back from it (docs/agent/command-sandbox,
 * docs/agent/command-capture).
 *
 * `head`/`tail` were always opt-in, which meant an output nobody bounded arrived whole:
 * a test suite's five thousand lines landed in the context as one JSON string. These
 * cases prove the default — a long output comes back as its tail, with `mode: default`
 * saying so — and that a truncated document always carries the handle that reaches the
 * rest of the stream.
 */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-default-window-test-')));

/** Split a success document into its header fields and its body. */
function parseDocument(text) {
  const lines = String(text).split('\n');
  const delimiter = lines.indexOf(OUTPUT_DELIMITER);
  const fields = {};
  for (const line of lines.slice(0, delimiter)) {
    const match = line.match(/^([a-z_]+): (.*)$/);
    if (match) fields[match[1]] = match[2];
  }
  return { fields, body: lines.slice(delimiter + 1).join('\n') };
}

test('windowCaptured bounds an output nobody asked to window', () => {
  const short = windowCaptured('line 1\nline 2');
  assert.equal(short.mode, 'all');
  assert.equal(short.truncated, false);

  const long = Array.from({ length: DEFAULT_WINDOW_LINES + 5 }, (_, i) => `line ${i + 1}`).join('\n');
  const bounded = windowCaptured(long);
  assert.equal(bounded.mode, 'default');
  assert.equal(bounded.shown, DEFAULT_WINDOW_LINES);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.text.endsWith(`line ${DEFAULT_WINDOW_LINES + 5}`), 'the tail is the default window');

  // An explicit window still wins over the default, in both directions.
  assert.equal(windowCaptured(long, { head: 2 }).mode, 'head');
  assert.equal(windowCaptured(long, { tail: 2 }).mode, 'tail');
});

test('a truncated command document hands back a capture that reaches the whole stream', async () => {
  clearCaptures();
  const total = DEFAULT_WINDOW_LINES + 3;
  fs.writeFileSync('long.txt', `${Array.from({ length: total }, (_, i) => `row ${i + 1}`).join('\n')}\n`);

  const doc = parseDocument(await runBashExecute({ command: 'cat long.txt', intent: 'read a long file' }));
  assert.equal(doc.fields.mode, 'default');
  assert.equal(doc.fields.lines, String(total));
  assert.equal(doc.fields.shown, String(DEFAULT_WINDOW_LINES));
  assert.equal(doc.fields.range, `${total - DEFAULT_WINDOW_LINES + 1}-${total}`);
  assert.match(doc.fields.capture, /^\d+$/, 'the document names the handle');
  // The header is YAML, so a hint carrying punctuation comes back quoted.
  assert.ok(doc.fields.hint.includes('read_capture'), `hint names the tool: ${doc.fields.hint}`);

  const head = parseDocument(await readCaptureExecute({
    capture: Number(doc.fields.capture),
    offset: 0,
    limit: 2,
    intent: 'read the start of the capture'
  }));
  assert.equal(head.body, '     1  row 1\n     2  row 2');

  // A command whose output fits is not truncated, so it hands back no handle at all.
  fs.writeFileSync('short.txt', 'one\ntwo\n');
  const small = parseDocument(await runBashExecute({ command: 'cat short.txt', intent: 'read a short file' }));
  assert.equal(small.fields.truncated, 'false');
  assert.equal(small.fields.capture, undefined);
});

test('a failing npm run keeps its envelope and hands back the capture of the whole output', async () => {
  clearCaptures();
  const out = Array.from({ length: 900 }, (_, i) => `not ok ${i + 1} - a failing assertion`).join('\n');
  const failure = npmFailure({
    command: 'npm test',
    cwd: process.cwd(),
    out,
    err: 'npm warn something',
    code: 'NPM_FAILED',
    exitCode: 1
  });

  assert.equal(failure.status, 'error');
  assert.equal(failure.code, 'NPM_FAILED');
  assert.equal(failure.stdoutLines, 900);
  assert.equal(failure.stdoutTruncated, true);
  assert.ok(failure.stdoutShown < 900, 'the payload is a window, not the whole stream');
  assert.equal(failure.stderr, 'npm warn something');
  assert.equal(failure.stderrTruncated, false);
  assert.match(failure.hint, /read_capture/);
  assert.equal(getCapture(failure.capture).lines, 900, 'the handle really holds the whole stream');

  // The scan is the operation that makes a failing run usable: the one line that failed.
  const scan = await readCaptureExecute({ capture: failure.capture, pattern: 'not ok 42 -', intent: 'find the failure' });
  assert.match(scan, /not ok 42 - a failing assertion/);
});

test('a success document without a capture never grows a capture field', () => {
  const doc = parseDocument(renderCommandOutput({
    command: 'true',
    cwd: '.',
    stdout: 'ok',
    total: 1,
    shown: 1,
    truncated: false,
    mode: 'all'
  }));
  assert.equal(doc.fields.capture, undefined);
  assert.equal(doc.fields.hint, undefined);
  assert.equal(doc.body, 'ok');
});
