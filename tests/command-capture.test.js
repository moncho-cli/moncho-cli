import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  putCapture,
  getCapture,
  dropCapture,
  clearCaptures,
  captureIds,
  captureStats,
  capturesRequestedBy,
  DEFAULT_MAX_CAPTURES
} from '../utils/capture-store.js';
import { selectCapture, splitCaptureLines, CaptureRangeError } from '../utils/capture-window.js';
import { execute as readCaptureExecute } from '../tools/read_capture.js';
import { handleToolBatch } from '../app/tool-batch.js';
import { loadTools } from '../utils/tool-loader.js';
import { ContextWindow } from '../app/context-window.js';

/**
 * A capture is the file-like half of a command document: when a command's output is too
 * long to hand over whole, the document carries a `capture` handle and the bytes stay in
 * memory (`docs/agent/command-capture`). These cases prove the store's bounds, the two
 * selections over it (a page, a scan), the tool that exposes them, and the rule that a
 * capture expires as soon as the next batch does not read it.
 */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-capture-test-')));
fs.writeFileSync('fixture.txt', 'hello\n');

const LINES = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`).join('\n');

/** One assistant `tool_calls` entry, in the shape the batch receives. */
function call(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

test('the capture store keeps a bounded number of captures, oldest first', () => {
  clearCaptures();
  for (let i = 0; i < DEFAULT_MAX_CAPTURES + 2; i++) putCapture({ command: `cmd ${i}`, text: 'one\ntwo' });

  assert.equal(captureStats().count, DEFAULT_MAX_CAPTURES, 'the store is capped');
  const ids = captureIds();
  assert.equal(ids.length, DEFAULT_MAX_CAPTURES);
  assert.equal(getCapture(ids[0] - 1), null, 'the oldest capture is the one dropped');
  assert.equal(getCapture(ids.at(-1)).command, `cmd ${DEFAULT_MAX_CAPTURES + 1}`);

  // Handles are monotonic: an old transcript must never address a newer capture.
  const later = putCapture({ text: 'x' });
  assert.ok(later.id > ids.at(-1), 'a handle is never reused');
  assert.equal(getCapture(String(later.id)).id, later.id, 'a stringified handle resolves too');
  assert.equal(dropCapture(later.id), true);
  assert.equal(getCapture(later.id), null);

  // Which handles a batch asked to read is the one input that decides what survives.
  assert.deepEqual(
    capturesRequestedBy([
      { name: 'read_capture', args: { capture: 7 } },
      { name: 'read_file', args: { path: 'a.txt' } },
      { name: 'read_capture', args: 'not parsed' },
      { name: 'read_capture' }
    ]),
    [7]
  );
  clearCaptures();
});

// ---------------------------------------------------------------------------
// The selection
// ---------------------------------------------------------------------------

test('selectCapture pages a numbered window and scans for a pattern', () => {
  const text = `${LINES}\n`;
  assert.equal(splitCaptureLines(text).length, 1200);

  const page = selectCapture(text, { offset: 10, limit: 3 });
  assert.equal(page.mode, 'page');
  assert.equal(page.shown, 3);
  assert.equal(page.from, 11);
  assert.equal(page.to, 13);
  assert.equal(page.body, '    11  line 11\n    12  line 12\n    13  line 13');
  assert.equal(page.truncated, true, 'a page that is not the whole capture says so');

  // A negative offset counts from the end, like read_file, so the tail is one call.
  const tail = selectCapture(text, { offset: -2, limit: 5 });
  assert.equal(tail.from, 1199);
  assert.equal(tail.body, '  1199  line 1199\n  1200  line 1200');

  const scan = selectCapture(text, { pattern: 'line 7\\b' });
  assert.equal(scan.mode, 'scan');
  assert.equal(scan.matches, 1);
  assert.equal(scan.body, '     7  line 7');

  const fixed = selectCapture(text, { pattern: 'line 1', fixedStrings: true, maxMatches: 2 });
  assert.equal(fixed.matches, 2);

  assert.throws(() => selectCapture(text, { limit: 0 }), (e) => e instanceof CaptureRangeError && e.code === 'INVALID_RANGE');
  assert.throws(() => selectCapture(text, { pattern: '[' }), (e) => e.code === 'INVALID_PATTERN');
});

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

test('read_capture answers a numbered page, a scan, and an expired handle', async () => {
  clearCaptures();
  const entry = putCapture({ command: 'npm test', text: LINES });

  const paged = await readCaptureExecute({ capture: entry.id, offset: 0, limit: 2, intent: 'read the top' });
  assert.match(paged, new RegExp(`^status: success\ncapture: ${entry.id}\n`));
  assert.match(paged, /lines: 1200\n/);
  assert.match(paged, /shown: 2\n/);
  assert.match(paged, /\n---\n {5}1 {2}line 1\n/);

  const scanned = await readCaptureExecute({ capture: entry.id, pattern: 'line 42$', intent: 'find the failure' });
  assert.match(scanned, /mode: scan\n/);
  assert.match(scanned, /matches: 1\n/);
  assert.match(scanned, / {4}42 {2}line 42/);

  const nonsense = JSON.parse(await readCaptureExecute({ capture: entry.id, limit: 5000, intent: 'ask for too much' }));
  assert.equal(nonsense.status, 'error');
  assert.equal(nonsense.code, 'INVALID_RANGE');

  // An expired handle is reported, never rendered as an empty page.
  dropCapture(entry.id);
  const expired = JSON.parse(await readCaptureExecute({ capture: entry.id, intent: 'read a capture that is gone' }));
  assert.equal(expired.status, 'error');
  assert.equal(expired.code, 'CAPTURE_EXPIRED');
  assert.match(expired.message, /no longer in memory/);
});

// ---------------------------------------------------------------------------
// Expiry, at the one place that knows when a batch ends
// ---------------------------------------------------------------------------

test('a capture expires when the next batch does not read it, and survives one that does', async () => {
  clearCaptures();
  const { toolFunctions } = await loadTools(() => {});
  const window = new ContextWindow({ maxTokens: 100000 });
  let made = null;

  // A batch that reads the capture keeps it alive.
  const read = putCapture({ command: 'npm test', text: LINES });
  await handleToolBatch({
    toolCalls: [call('a', 'read_capture', { capture: read.id, limit: 2, intent: 'read the capture' })],
    window,
    toolFunctions
  });
  assert.ok(getCapture(read.id), 'a capture the batch read survives it');

  // A capture taken *during* a batch is kept for the next one; the ones that already
  // existed and were not read by it are dropped.
  const stale = putCapture({ command: 'npm ls', text: LINES });
  const withCapture = {
    ...toolFunctions,
    make_capture: async () => {
      made = putCapture({ command: 'node big.js', text: LINES });
      return 'ok';
    }
  };
  await handleToolBatch({
    toolCalls: [
      call('b', 'make_capture', { intent: 'take a capture inside the batch' }),
      call('c', 'read_file', { path: 'fixture.txt', intent: 'read the fixture' })
    ],
    window,
    toolFunctions: withCapture
  });
  assert.equal(getCapture(stale.id), null, 'a capture nobody read goes when the batch ends');
  assert.ok(made && getCapture(made.id), 'a capture taken during the batch lives until the next one');

  // And one batch later, unread, it is gone.
  await handleToolBatch({
    toolCalls: [call('d', 'read_file', { path: 'fixture.txt', intent: 'read the fixture again' })],
    window,
    toolFunctions
  });
  assert.equal(getCapture(made.id), null, 'the following batch drops it');
  assert.equal(captureStats().count, 0);
});
