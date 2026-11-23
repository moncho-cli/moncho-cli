import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  NO_META,
  buildChunkMeta,
  metaRepeated,
  isChunkMeta,
  normalizeMeta,
  summarizeMeta,
} from '../utils/chunk-meta.js';
import { ContextWindow } from '../app/context-window.js';
import {
  serializeConversationLog,
  parseConversationLog,
  formatConversationLog,
  conversationLogChunks,
  conversationLogMeta,
} from '../utils/conversation-log.js';
import {
  writeConversationLog,
  readConversationLog,
  readConversationLogMeta,
} from '../utils/conversation-log-store.js';
import { BRAND_VERSION } from '../app/brand.js';

/**
 * Proof for the per-chunk provenance (docs/runtime/chunk-provenance).
 *
 * The gap this closes: the record held the conversation but not *what produced it* or
 * *what it weighed*, so a change to the prompt, the tools or the collapse could not be
 * told from a regression later. These cases prove the two facts are captured per chunk,
 * that they never ride on the chunk (which is sent verbatim), that they survive a write
 * and a resume, and — the subtle one — that the version recorded is **Moncho's**, never
 * the version of the project the agent happens to be working in.
 */

const ID = 'chunk-meta-test';
// Project-relative: every file tool resolves through the sandbox, which refuses an
// absolute path, so a fixture directory is named the way the real one is.
const DIR = 'agent/tmp-chunk-meta';
const ROOT = path.resolve(import.meta.dirname, '..');

test.after(() => {
  fs.rmSync(path.join(ROOT, DIR), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Whose version is it
// ---------------------------------------------------------------------------

test('the stamped version is Moncho own, never the working project version', () => {
  // The decoy: a directory that is a perfectly plausible project, with its own version.
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-decoy-'));
  fs.writeFileSync(
    path.join(decoy, 'package.json'),
    JSON.stringify({ name: 'the-users-app', version: '99.99.99' }),
    'utf-8',
  );

  // Ask a *fresh* process to report what a real run would stamp, with the decoy as its
  // working directory — the user flow, where Moncho runs inside someone else's checkout.
  //
  // Nothing is passed for the version on purpose. The protection being tested is the
  // manager's own default (`options.monchoVersion ?? BRAND_VERSION`), so a test that
  // hands the version in would pass even if that default were wrong.
  const script = [
    `import { ConversationManager } from ${JSON.stringify(path.join(ROOT, 'app/conversation-manager.js'))};`,
    `import { BRAND_VERSION } from ${JSON.stringify(path.join(ROOT, 'app/brand.js'))};`,
    'const manager = new ConversationManager({}, () => [], () => null, { log: () => {} });',
    "manager.contextWindow.add({ role: 'user', content: 'a chunk' });",
    'process.stdout.write(JSON.stringify({',
    '  stamped: manager.contextWindow.journalMeta[0].moncho,',
    '  brand: BRAND_VERSION,',
    '}));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
    cwd: decoy,
  });
  assert.equal(result.status, 0, result.stderr);

  const { stamped, brand } = JSON.parse(result.stdout);
  assert.equal(stamped, brand, 'a run that names no version stamps the brand version');
  assert.notEqual(stamped, '99.99.99', 'never the version of the project being worked in');
  assert.match(stamped, /^\d+\.\d+\.\d+/, 'and it is a real semver');
});

test('the field is named for whose version it is', () => {
  // The name is the guard: a field called `app` or `version` in a record written inside a
  // user's checkout invites exactly the reading this test rules out.
  const meta = buildChunkMeta({ role: 'user', content: 'a' }, { moncho: '0.25.0' });
  assert.deepEqual(Object.keys(meta).sort(), ['moncho', 'tokens']);
  assert.equal('app' in meta, false);
  assert.equal('version' in meta, false);
});

// ---------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------

test('a chunk meta names the build and the atomic token estimate of that chunk alone', () => {
  const meta = buildChunkMeta({ role: 'user', content: 'x'.repeat(400) }, { moncho: '0.25.0' });
  assert.equal(meta.moncho, '0.25.0');
  assert.ok(meta.tokens > 0, 'a chunk with content weighs something');
  // Atomic, not cumulative: the same chunk described twice weighs the same.
  assert.deepEqual(buildChunkMeta({ role: 'user', content: 'x'.repeat(400) }, { moncho: '0.25.0' }), meta);
});

test('a bigger chunk weighs more, so the estimate tracks content', () => {
  const small = buildChunkMeta({ role: 'user', content: 'hi' }, { moncho: '1.0.0' });
  const big = buildChunkMeta({ role: 'user', content: 'x'.repeat(4000) }, { moncho: '1.0.0' });
  assert.ok(big.tokens > small.tokens);
});

test('a missing version is null rather than an empty string', () => {
  assert.equal(buildChunkMeta({ role: 'user', content: 'a' }).moncho, null);
  assert.equal(buildChunkMeta({ role: 'user', content: 'a' }, { moncho: '   ' }).moncho, null);
  assert.equal(buildChunkMeta({ role: 'user', content: 'a' }, { moncho: ' 0.25.0 ' }).moncho, '0.25.0');
});

test('an entry that cannot be estimated still keeps the version', () => {
  // The version is the half that cannot be recomputed later, so a failing estimator
  // never costs the entry its provenance.
  const meta = buildChunkMeta({ role: 'user', content: 'a' }, {
    moncho: '0.25.0',
    estimate: () => { throw new Error('no estimate available'); },
  });
  assert.equal(meta.moncho, '0.25.0');
  assert.equal(meta.tokens, 0);
});

test('metaRepeated describes a whole batch the same way', () => {
  const batch = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  const meta = metaRepeated(batch, { moncho: '2.0.0' });
  assert.equal(meta.length, 2);
  assert.deepEqual(meta.map((entry) => entry.moncho), ['2.0.0', '2.0.0']);
});

test('isChunkMeta accepts a real entry and refuses junk', () => {
  assert.equal(isChunkMeta({ moncho: '1.0.0', tokens: 3 }), true);
  assert.equal(isChunkMeta({ moncho: null, tokens: 0 }), true, 'a known weight with an unknown build is still an entry');
  assert.equal(isChunkMeta(null), false);
  assert.equal(isChunkMeta('nope'), false);
  assert.equal(isChunkMeta([]), false);
  assert.equal(isChunkMeta({ moncho: '', tokens: 3 }), false, 'an empty version is not a version');
  assert.equal(isChunkMeta({ moncho: '1.0.0' }), false, 'a weight is required');
  assert.equal(isChunkMeta({ moncho: '1.0.0', tokens: 'heavy' }), false);
  // The old field name is not accepted as a stand-in: a record carrying `app` is a
  // record whose version provenance is unknown, which is exactly what null means.
  assert.equal(isChunkMeta({ app: '1.0.0', tokens: 3 }), false);
});

test('normalizeMeta forces one entry per chunk, junk becoming null', () => {
  const meta = normalizeMeta([{ moncho: '1.0.0', tokens: 5 }, 'nonsense'], 4);
  assert.equal(meta.length, 4, 'never shorter than the chunk count');
  assert.deepEqual(meta[0], { moncho: '1.0.0', tokens: 5 });
  assert.equal(meta[1], NO_META);
  assert.equal(meta[2], NO_META);
  assert.equal(meta[3], NO_META);
  // A long list is trimmed rather than shifting rows.
  assert.equal(normalizeMeta([{ moncho: '1.0.0', tokens: 1 }], 0).length, 0);
});

test('summarizeMeta answers which builds wrote what, without loading the chunks', () => {
  const summary = summarizeMeta([
    { moncho: '0.24.0', tokens: 100 },
    { moncho: '0.25.0', tokens: 40 },
    { moncho: '0.25.0', tokens: 60 },
    null,
  ]);
  assert.equal(summary.chunks, 3, 'null entries are counted as unknown, not as chunks');
  assert.equal(summary.unknown, 1);
  assert.equal(summary.tokens, 200);
  assert.deepEqual(summary.versions, [
    { moncho: '0.24.0', chunks: 1, tokens: 100 },
    { moncho: '0.25.0', chunks: 2, tokens: 100 },
  ]);
});

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

test('the window stamps each chunk as it enters, never on the chunk', () => {
  const window = new ContextWindow({ monchoVersion: '0.25.0' });
  const chunk = { role: 'user', content: 'hello' };
  window.add(chunk);

  assert.equal(window.journalMeta.length, 1);
  assert.equal(window.journalMeta[0].moncho, '0.25.0');
  // The decisive rule: the chunk is sent verbatim, and the window and the journal hold
  // the *same object*, so a field on it would be sent and stored.
  assert.equal('meta' in chunk, false, 'nothing rides on the chunk');
  assert.equal(Object.keys(chunk).length, 2, 'the chunk is exactly what the caller passed');
});

test('a batch is described once, one entry per chunk', () => {
  const window = new ContextWindow({ monchoVersion: '0.25.0' });
  window.addMany([{ role: 'user', content: 'a' }, { role: 'tool', content: 'b' }]);
  assert.equal(window.journalMeta.length, 2);
  assert.equal(window.journalMeta.length, window.journal.length, 'aligned with the journal');
});

test('the provenance stays aligned with the journal across a compaction', async () => {
  const window = new ContextWindow({ maxTokens: 200, monchoVersion: '0.25.0' });
  for (let i = 0; i < 8; i += 1) window.add({ role: 'user', content: `${i}`.repeat(400) });

  const before = window.journal.length;
  assert.equal(window.journalMeta.length, before);

  await window.compact({ callModel: async () => 'a summary' });
  // The window shrank; the journal did not, so neither did its provenance.
  assert.ok(window.chunks.length < before, 'the window really was compacted');
  assert.equal(window.journal.length, before, 'the journal is append-only');
  assert.equal(window.journalMeta.length, before, 'and its provenance is never re-aligned');
});

test('an unset version yields an entry with a null build', () => {
  const window = new ContextWindow();
  window.add({ role: 'user', content: 'a' });
  assert.equal(window.journalMeta[0].moncho, null);
});

test('clear() empties the provenance with everything else', () => {
  const window = new ContextWindow({ monchoVersion: '0.25.0' });
  window.add({ role: 'user', content: 'a' });
  window.clear();
  assert.deepEqual(window.journalMeta, []);
});

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

test('the log carries the meta beside its chunks, with a summary', () => {
  const chunks = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  const meta = metaRepeated(chunks, { moncho: '0.25.0' });
  const record = serializeConversationLog({ id: ID, chunks, meta });

  assert.equal(record.meta.length, 2);
  assert.equal(record.meta[0].moncho, '0.25.0');
  assert.equal(record.metaSummary.chunks, 2);
  assert.deepEqual(record.metaSummary.versions.map((entry) => entry.moncho), ['0.25.0']);
  assert.deepEqual(parseConversationLog(formatConversationLog(record)).meta, record.meta);
});

test('a log with no meta is byte-for-byte what it always was', () => {
  const chunks = [{ role: 'user', content: 'a' }];
  const record = serializeConversationLog({ id: ID, chunks });
  assert.equal('meta' in record, false, 'the field is absent, not empty');
  assert.equal('metaSummary' in record, false);

  // And a log written before the field existed still parses.
  const old = JSON.stringify({ version: 1, kind: 'conversation-log', id: ID, chunks });
  assert.deepEqual(conversationLogChunks(old), chunks);
  assert.equal(conversationLogMeta(old), null, 'no meta is the honest answer, not a guess');
});

test('the meta is written to the session folder and read back', () => {
  const chunks = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  const meta = metaRepeated(chunks, { moncho: '0.25.0' });

  writeConversationLog({ id: ID, chunks, meta }, { dir: DIR });
  assert.deepEqual(readConversationLog(ID, { dir: DIR }), chunks, 'the chunks still read back');
  assert.deepEqual(readConversationLogMeta(ID, { dir: DIR }), meta, 'and so does the provenance');
});

test('reading a meta that was never written answers null, never a throw', () => {
  assert.equal(readConversationLogMeta('never-written', { dir: DIR }), null);

  // A half-written file must not be able to block anything.
  const broken = path.join(ROOT, DIR, 'broken');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'conversation.json'), '{"version":1,', 'utf-8');
  assert.equal(readConversationLogMeta('broken', { dir: DIR }), null);
});

test('a resumed window restores the provenance with the journal', () => {
  const window = new ContextWindow({ monchoVersion: '0.26.0' });
  const journal = [{ role: 'user', content: 'old, compacted away' }, { role: 'user', content: 'recent' }];
  const meta = metaRepeated(journal, { moncho: '0.25.0' });

  window.replace([journal[1]], { journal, meta });
  assert.deepEqual(window.journal, journal, 'the history comes back');
  assert.equal(window.journalMeta.length, 2, 'and so does its provenance');
  assert.equal(window.journalMeta[0].moncho, '0.25.0', 'the stored build, not the running one');
});

test('a resume with no stored meta pads rather than shifting rows', () => {
  const window = new ContextWindow({ monchoVersion: '0.26.0' });
  const journal = [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }];
  window.replace([journal[1]], { journal });
  assert.deepEqual(window.journalMeta, [NO_META, NO_META], 'one entry per chunk, all unknown');
});
