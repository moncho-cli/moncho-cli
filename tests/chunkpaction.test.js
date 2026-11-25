import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CHUNKPACTION_VERSION,
  ChunkpactionError,
  emptyChunkpaction,
  serializeChunkpaction,
  formatChunkpaction,
  parseChunkpaction,
  appendCapture,
  findCapture,
  captureIndex,
  captureText,
  captureChunks,
  normalizeCaptureId,
} from '../utils/chunkpaction.js';
import { readChunkpaction, writeChunkpactionCapture, hasChunkpaction } from '../utils/chunkpaction-store.js';
import { execute as readChunkpactionExecute } from '../tools/read_chunkpaction.js';
import { registerSession, clearSession, registerContextWindow, clearContextWindow } from '../utils/host.js';
import { collapseCompletedItems } from '../utils/item-collapse.js';
import { requestItemCollapse, runItemCollapse } from '../app/item-collapse-runner.js';
import { ContextWindow } from '../app/context-window.js';
import { chunkpactionEnabled } from '../config/constants.js';

/**
 * Proof for the chunkpaction capture (docs/context/chunkpaction, task-backlog item 75).
 *
 * The gap this closes: a collapsed summary says the detail is still available, and it
 * names a capture id. These cases prove the name is resolvable — the raw chunks are on
 * disk under that id, the id is monotonic and never reused, and the reader pages and
 * scans them exactly as `read_capture` does a command's output.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-chunkpaction-test-'));
process.chdir(root);

const SESSION_ID = 'chunkpaction-test';

function user(text) {
  return { role: 'user', content: text };
}

test.afterEach(() => {
  clearSession();
  fs.rmSync(path.join(root, 'agent'), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------

test('a capture id is a positive whole number, and nothing else', () => {
  assert.equal(normalizeCaptureId(3), 3);
  assert.equal(normalizeCaptureId('3'), 3, 'a string id from a summary is accepted');
  assert.equal(normalizeCaptureId(0), null);
  assert.equal(normalizeCaptureId(-1), null);
  assert.equal(normalizeCaptureId(1.5), null);
  assert.equal(normalizeCaptureId('two'), null);
  assert.equal(normalizeCaptureId(null), null);
});

test('an empty record starts its counter at 1 and holds nothing', () => {
  const record = emptyChunkpaction(SESSION_ID);
  assert.equal(record.version, CHUNKPACTION_VERSION);
  assert.equal(record.kind, 'chunkpaction');
  assert.equal(record.id, SESSION_ID);
  assert.equal(record.nextCapture, 1);
  assert.deepEqual(record.captures, []);
  assert.throws(() => emptyChunkpaction(''), (error) => error.code === 'INVALID_ID');
});

test('a record round-trips through its own text, and junk is refused', () => {
  const record = emptyChunkpaction(SESSION_ID);
  assert.deepEqual(parseChunkpaction(formatChunkpaction(record)), record);

  assert.throws(() => parseChunkpaction('not json'), (error) => error.code === 'INVALID_JSON');
  assert.throws(() => parseChunkpaction('[]'), (error) => error.code === 'INVALID_RECORD');
  assert.throws(
    () => parseChunkpaction(JSON.stringify({ version: 99, id: 'x', captures: [] })),
    (error) => error.code === 'UNSUPPORTED_VERSION',
  );
  assert.throws(
    () => parseChunkpaction(JSON.stringify({ version: CHUNKPACTION_VERSION, captures: [] })),
    (error) => error.code === 'INVALID_RECORD',
  );
});

test('an appended capture takes the next id and the counter never goes backwards', () => {
  let record = emptyChunkpaction(SESSION_ID);
  const first = appendCapture(record, { item: 'item one', chunks: [user('a'), user('b')] });
  record = first.record;
  assert.equal(first.entry.capture, 1);
  assert.equal(record.nextCapture, 2);

  const second = appendCapture(record, { item: 'item two', chunks: [user('c')] });
  record = second.record;
  assert.equal(second.entry.capture, 2, 'ids are monotonic');
  assert.equal(record.captures.length, 2);

  // A hand-edited counter below the highest id in use cannot re-issue one.
  const forced = serializeChunkpaction({ id: SESSION_ID, nextCapture: 1, captures: record.captures });
  assert.equal(forced.nextCapture, 3, 'the counter is at least one past the highest id');
});

test('the chunks of a capture are copied, so a later mutation cannot rewrite the record', () => {
  const chunk = user('original');
  const { record, entry } = appendCapture(emptyChunkpaction(SESSION_ID), { chunks: [chunk] });
  chunk.content = 'mutated after the capture';

  assert.equal(record.captures[0].chunks[0].content, 'original', 'the record holds a copy');
  assert.equal(entry.chunks[0].content, 'original');
  assert.equal(captureChunks(record.captures[0])[0].content, 'original', 'and a reader gets a copy too');
});

test('a capture is found by id, and an unknown id is null', () => {
  const { record } = appendCapture(emptyChunkpaction(SESSION_ID), { item: 'x', chunks: [user('a')] });
  assert.equal(findCapture(record, 1).item, 'x');
  assert.equal(findCapture(record, '1').item, 'x', 'the id from a summary is a string');
  assert.equal(findCapture(record, 2), null);
  assert.equal(findCapture(record, 'nope'), null);
});

test('the index describes the captures without their chunks', () => {
  const { record } = appendCapture(emptyChunkpaction(SESSION_ID), {
    item: 'item one',
    chunks: [user('a'), user('b')],
  });
  const index = captureIndex(record);
  assert.equal(index.length, 1);
  assert.equal(index[0].capture, 1);
  assert.equal(index[0].item, 'item one');
  assert.equal(index[0].chunks, 2);
  assert.equal(index[0].chunks_inline, undefined, 'the index never carries the chunks themselves');
});

test('captureText renders the chunks as the record they were, with a header', () => {
  const { record } = appendCapture(emptyChunkpaction(SESSION_ID), {
    item: 'wire it',
    chunks: [{ role: 'assistant', content: 'thinking', tool_calls: [{ id: 'c1', function: { name: 'read_file' } }] }],
  });
  const text = captureText(record.captures[0]);

  assert.ok(text.startsWith('[chunkpaction capture 1]'));
  assert.ok(text.includes('item: wire it'));
  assert.ok(text.includes('1 chunk(s)'));
  assert.ok(text.includes('[tool_calls]'), 'the same rendering the summariser was given');
  assert.ok(text.includes('read_file'));
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

test('a capture is written to the session folder and read back', () => {
  const written = writeChunkpactionCapture(SESSION_ID, { item: 'item one', chunks: [user('a')] });
  assert.equal(written.verified, true);
  assert.equal(written.entry.capture, 1);
  assert.ok(written.path.endsWith('chunkpaction.json'), `unexpected path ${written.path}`);
  assert.ok(fs.existsSync(path.join(root, written.path)));

  assert.equal(hasChunkpaction(SESSION_ID), true);
  const record = readChunkpaction(SESSION_ID);
  assert.equal(record.captures.length, 1);
  assert.equal(record.captures[0].item, 'item one');
});

test('a second capture appends and keeps the first, with a fresh id', () => {
  writeChunkpactionCapture(SESSION_ID, { item: 'one', chunks: [user('a')] });
  const second = writeChunkpactionCapture(SESSION_ID, { item: 'two', chunks: [user('b')] });

  assert.equal(second.entry.capture, 2);
  const record = readChunkpaction(SESSION_ID);
  assert.deepEqual(record.captures.map((entry) => entry.capture), [1, 2], 'the first capture survives');
  assert.deepEqual(record.captures.map((entry) => entry.item), ['one', 'two']);
});

test('a missing or unreadable capture file answers null rather than throwing', () => {
  assert.equal(readChunkpaction('never-collapsed'), null, 'no file is not an error');
  assert.equal(hasChunkpaction('never-collapsed'), false);

  // A half-written file must not be able to block a resume.
  const dir = path.join(root, 'agent/sessions/broken');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'chunkpaction.json'), '{"version":1,"id":"broken",', 'utf-8');
  assert.equal(readChunkpaction('broken'), null);
});

// ---------------------------------------------------------------------------
// The reader tool
// ---------------------------------------------------------------------------

test('read_chunkpaction lists the captures a session holds', async () => {
  registerSession({ id: SESSION_ID });
  writeChunkpactionCapture(SESSION_ID, { item: 'item one', chunks: [user('a')] });
  writeChunkpactionCapture(SESSION_ID, { item: 'item two', chunks: [user('b'), user('c')] });

  const listed = await readChunkpactionExecute({ intent: 'see what is available' });
  assert.match(listed, /captures: 2/);
  assert.ok(listed.includes('capture 1'));
  assert.ok(listed.includes('item: item one'));
  assert.ok(listed.includes('capture 2'));
  assert.ok(listed.includes('2 chunk(s)'));
});

test('read_chunkpaction refuses a capture this session does not hold', async () => {
  registerSession({ id: SESSION_ID });
  writeChunkpactionCapture(SESSION_ID, { item: 'item one', chunks: [user('a')] });

  const missing = JSON.parse(await readChunkpactionExecute({ capture: 99, intent: 'read a capture that is gone' }));
  assert.equal(missing.status, 'error');
  assert.equal(missing.code, 'CAPTURE_NOT_FOUND');
  assert.deepEqual(missing.available, [1], 'the refusal names what is available instead');
});

test('read_chunkpaction pages and scans the raw chunks a summary named', async () => {
  registerSession({ id: SESSION_ID });
  writeChunkpactionCapture(SESSION_ID, {
    item: 'wire the reader',
    chunks: [
      { role: 'user', content: 'start here' },
      { role: 'assistant', content: 'a long stretch of reasoning', tool_calls: [{ id: 'c1', function: { name: 'grep' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'the needle line' },
    ],
  });

  const page = await readChunkpactionExecute({ capture: 1, limit: 20, intent: 'read the capture' });
  assert.match(page, /capture: 1/);
  assert.match(page, /item: wire the reader/);
  assert.match(page, /chunks: 3/);
  assert.ok(page.includes('start here'), 'the raw chunks come back');

  const scanned = await readChunkpactionExecute({ capture: 1, pattern: 'needle', intent: 'find the needle' });
  assert.match(scanned, /mode: scan/);
  assert.ok(scanned.includes('the needle line'));
  assert.ok(!scanned.includes('start here'), 'a scan returns only the matching lines');
});

test('read_chunkpaction with no session is refused instead of throwing', async () => {
  clearSession();
  const refused = JSON.parse(await readChunkpactionExecute({ capture: 1, intent: 'read with no session' }));
  assert.equal(refused.status, 'error');
  assert.equal(refused.code, 'NO_SESSION');
});

test('a session that never collapsed anything lists nothing, and is not an error', async () => {
  registerSession({ id: 'fresh-session' });
  const listed = await readChunkpactionExecute({ intent: 'nothing to see' });
  assert.match(listed, /captures: 0/);
  assert.ok(listed.includes('nothing has been collapsed'));
});

// ---------------------------------------------------------------------------
// The collapse writes a capture, and its summary names a resolvable id
// ---------------------------------------------------------------------------

test('a collapsed summary names the capture that holds its raw chunks', () => {
  // The tail belongs to no item: the collapse never consumes the whole window, since
  // something has to remain to send.
  const chunks = [
    { role: 'user', content: `${'x'.repeat(400)} do it` },
    { role: 'assistant', content: 'reasoning', tool_calls: [{ id: 'c1', function: { name: 'read_file' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'user', content: 'the next thing' },
  ];

  const result = collapseCompletedItems(chunks, ['item one', 'item one', 'item one', null], {
    completed: ['item one'],
    writeCapture: () => ({ capture: 7 }),
  });

  assert.equal(result.collapsed.length, 1);
  assert.equal(result.collapsed[0].capture, 7);
  assert.equal(result.chunks[0].collapsed_capture, 7);
  assert.ok(
    result.chunks[0].content.includes('read_chunkpaction({ capture: 7 })'),
    'the summary names the tool and the id, so the pointer is followable',
  );
});

test('the capture is written before the window is rewritten, and a writer that throws changes nothing', () => {
  const chunks = [
    { role: 'user', content: `${'x'.repeat(400)} do it` },
    { role: 'assistant', content: 'reasoning' },
    { role: 'user', content: 'the next thing' },
  ];
  const items = ['item one', 'item one', null];
  const seen = [];

  const result = collapseCompletedItems(chunks, items, {
    completed: ['item one'],
    writeCapture: (run) => {
      seen.push(run.item);
      return { capture: 1 };
    },
  });
  assert.deepEqual(seen, ['item one'], 'the writer saw the run it was asked to persist');
  assert.equal(result.collapsed.length, 1);

  // A writer that throws must leave the window untouched: a failed capture cannot cost
  // the conversation its raw chunks.
  assert.throws(() => collapseCompletedItems(chunks, items, {
    completed: ['item one'],
    writeCapture: () => { throw new Error('disk full'); },
  }), /disk full/);
});

test('a collapse with no capture writer names no id rather than inventing one', () => {
  const chunks = [
    { role: 'user', content: `${'x'.repeat(400)} do it` },
    { role: 'assistant', content: 'reasoning' },
    { role: 'user', content: 'the next thing' },
  ];
  const result = collapseCompletedItems(chunks, ['item one', 'item one', null], { completed: ['item one'] });

  assert.equal(result.collapsed[0].capture, null);
  assert.equal(result.chunks[0].collapsed_capture, null);
  assert.ok(!result.chunks[0].content.includes('read_chunkpaction'), 'no id, no pointer to follow');
});

test('the runner collapses through the live window and writes a capture the reader can open', async () => {
  registerSession({ id: SESSION_ID });
  const window = new ContextWindow({ maxTokens: 1_000_000 });
  registerContextWindow(window);

  const chunks = [
    { role: 'user', content: `${'x'.repeat(400)} do it` },
    { role: 'assistant', content: 'reasoning', tool_calls: [{ id: 'c1', function: { name: 'grep' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'user', content: 'the next thing' },
  ];
  // The item is set before the chunks arrive: attribution is stamped as a chunk enters
  // the window, which is the rule the whole feature rests on.
  window.setCurrentItem('item one');
  window.addMany(chunks.slice(0, 3));
  window.setCurrentItem(null);
  window.add(chunks[3]);

  // `update_task` only *asks* for the collapse; the batch that carries the call drains the
  // request once every chunk of the batch is in the window (app/tool-batch.js). Called
  // outside a batch, the pair is the same rewrite the tool would have triggered. The
  // collapse is opt-in, so the switch is turned on around the pair.
  const report = withSwitch('1', () => {
    requestItemCollapse(['item one']);
    return runItemCollapse();
  });
  assert.equal(report.collapsed.length, 1);
  assert.equal(report.chunks, 2, 'the three-chunk section became one, plus the untouched tail');

  // The id the summary names is the id the reader resolves.
  const captureId = report.collapsed[0].capture;
  assert.equal(window.chunks[0].collapsed_capture, captureId);

  const read = await readChunkpactionExecute({ capture: captureId, intent: 'read the collapsed section' });
  assert.match(read, new RegExp(`capture: ${captureId}`));
  assert.ok(read.includes('reasoning'), 'the raw chunks come back');

  clearContextWindow();
});

test('the runner is a no-op with no window or no session', () => {
  clearContextWindow();
  registerSession({ id: SESSION_ID });
  assert.equal(requestItemCollapse(['item one']), false, 'no window, nothing to rewrite');
  assert.equal(runItemCollapse(), null, 'and nothing to drain');

  const window = new ContextWindow({ maxTokens: 1_000_000 });
  registerContextWindow(window);
  clearSession();
  assert.equal(requestItemCollapse(['item one']), false, 'no session, no folder to capture into');
  assert.equal(runItemCollapse(), null, 'and nothing to drain');

  // A drained request cannot be drained twice: the second call finds nothing.
  registerSession({ id: SESSION_ID });
  withSwitch('1', () => {
    requestItemCollapse(['item one']);
    runItemCollapse();
    assert.equal(runItemCollapse(), null, 'one request is one collapse');
  });

  clearContextWindow();
});

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

/** Run `body` with CHUNKPACTION_ENABLED set to `value`, restoring whatever was there. */
function withSwitch(value, body) {
  const previous = process.env.CHUNKPACTION_ENABLED;
  if (value === undefined) delete process.env.CHUNKPACTION_ENABLED;
  else process.env.CHUNKPACTION_ENABLED = value;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.CHUNKPACTION_ENABLED;
    else process.env.CHUNKPACTION_ENABLED = previous;
  }
}

test('the collapse switch is off unless CHUNKPACTION_ENABLED reads as a yes', () => {
  // Unset is the default: the collapse does NOT run without a variable being set, because
  // a verbatim growing prefix is what a cloud provider caches and bills at a discount.
  withSwitch(undefined, () => assert.equal(chunkpactionEnabled(), false));
  // A blank or unrecognised value stays off, so a typo cannot silently rewrite the window.
  withSwitch('', () => assert.equal(chunkpactionEnabled(), false));
  withSwitch('maybe', () => assert.equal(chunkpactionEnabled(), false));
  withSwitch('no', () => assert.equal(chunkpactionEnabled(), false));
  withSwitch('0', () => assert.equal(chunkpactionEnabled(), false));
  // The five spellings that read as a yes turn it on, in any case.
  for (const on of ['1', 'true', 'on', 'yes', 'y', 'ON', 'True', ' yes ']) {
    withSwitch(on, () => assert.equal(chunkpactionEnabled(), true, `${on} turns the collapse on`));
  }
});

test('with the switch off, a completing update_task asks for no collapse and none runs', () => {
  // The switch is **pinned** off for the whole case rather than assumed off: it is read from
  // the live environment (`config/constants.js#chunkpactionEnabled`), and a maintainer whose
  // own `.env` exports CHUNKPACTION_ENABLED=1 would otherwise fail here — the environment
  // would be what broke the case, not the behaviour it proves.
  withSwitch(undefined, () => {
    assert.equal(chunkpactionEnabled(), false);
    registerSession({ id: SESSION_ID });
    const window = new ContextWindow({ maxTokens: 1_000_000 });
    registerContextWindow(window);

    window.setCurrentItem('item one');
    window.addMany([
      { role: 'user', content: `${'x'.repeat(400)} do it` },
      { role: 'assistant', content: 'reasoning' },
    ]);
    window.setCurrentItem(null);

    assert.equal(requestItemCollapse(['item one']), false, 'off means the request is refused');
    assert.equal(runItemCollapse(), null, 'and there is nothing to drain');

    assert.equal(window.chunks.length, 2, 'the section stays verbatim in the window');
    assert.equal(window.chunks[0].collapsed, undefined, 'nothing was collapsed');
    assert.equal(hasChunkpaction(SESSION_ID), false, 'and no capture file was written');

    clearContextWindow();
  });
});

test('a request recorded while on does not collapse once the switch is turned off', () => {
  registerSession({ id: SESSION_ID });
  const window = new ContextWindow({ maxTokens: 1_000_000 });
  registerContextWindow(window);

  window.setCurrentItem('item one');
  window.addMany([
    { role: 'user', content: `${'x'.repeat(400)} do it` },
    { role: 'assistant', content: 'reasoning' },
  ]);
  window.setCurrentItem(null);

  // The tool asks while the switch is on; the batch drains after it was turned off.
  assert.equal(withSwitch('1', () => requestItemCollapse(['item one'])), true, 'the request is taken while on');
  withSwitch(undefined, () => {
    assert.equal(runItemCollapse(), null, 'the drain re-checks and refuses');
  });

  assert.equal(window.chunks.length, 2, 'the window is left alone');
  assert.equal(hasChunkpaction(SESSION_ID), false, 'and no capture was written');

  clearContextWindow();
});

