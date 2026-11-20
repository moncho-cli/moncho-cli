import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ContextWindow } from '../app/context-window.js';
import {
  CONVERSATION_LOG_VERSION,
  ConversationLogError,
  serializeConversationLog,
  formatConversationLog,
  parseConversationLog,
  conversationLogChunks,
} from '../utils/conversation-log.js';
import {
  writeConversationLog,
  readConversationLog,
  hasConversationLog,
} from '../utils/conversation-log-store.js';
import { conversationPath, sessionPath } from '../utils/session-store.js';
import { createSessionRecorder } from '../app/session-recorder.js';

/**
 * `conversation.json`: the uncompacted history beside `context.json`.
 *
 * Two properties are the whole point of the file and both are proven here:
 *  - the *compaction* never touches it — the window that is sent shrinks while the log
 *    keeps every chunk all the way back;
 *  - a *missing or unreadable* log is `null`, never a throw and never a block on
 *    resuming a conversation the live record can still describe.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-conversation-log-test-'));
process.chdir(root);
const DIR = 'sessions';
const ID = 's1';

const read = (name) => fs.readFileSync(name, 'utf-8');

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A window holding `count` user chunks of `size` chars each. */
function windowWith(count, size = 60) {
  const window = new ContextWindow({ maxTokens: 100000 });
  for (let i = 0; i < count; i += 1) {
    window.add({ role: 'user', content: `${i}`.repeat(size) });
  }
  return window;
}

test('the shape holds the chunks verbatim, versioned and counted', () => {
  const chunks = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }];
  const record = serializeConversationLog({ id: ID, chunks });

  assert.equal(record.version, CONVERSATION_LOG_VERSION);
  assert.equal(record.kind, 'conversation-log');
  assert.equal(record.id, ID);
  assert.deepEqual(record.counts, { chunks: 2, roles: { user: 1, assistant: 1 } });

  // The file on disk is pretty-printed JSON ending in a newline, like context.json.
  const text = formatConversationLog(record);
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(parseConversationLog(text).chunks, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]);

  // The copy is defensive both ways: a later mutation of the live window cannot rewrite
  // the record, and a mutation of the record cannot rewrite the live window.
  chunks[0].content = 'live mutation';
  assert.equal(record.chunks[0].content, 'hello');
  record.chunks[1].content = 'record mutation';
  assert.equal(chunks[1].content, 'hi');

  // A log with no id cannot belong to a session, and chunks must be an array.
  assert.throws(() => serializeConversationLog({ chunks }), (error) => error.code === 'INVALID_ID');
  assert.throws(() => serializeConversationLog({ id: ID, chunks: 'no' }), (error) => error.code === 'INVALID_CHUNKS');
});

test('parseConversationLog() refuses junk and unknown versions instead of guessing', () => {
  assert.throws(() => parseConversationLog('{'), (error) => error.code === 'INVALID_JSON');
  assert.throws(() => parseConversationLog('[1,2]'), (error) => error.code === 'INVALID_LOG');
  assert.throws(() => parseConversationLog('{"version":1,"chunks":[]}'), (error) => error.code === 'INVALID_LOG');
  assert.throws(
    () => parseConversationLog(JSON.stringify({ version: 99, id: ID, chunks: [] })),
    (error) => error.code === 'UNSUPPORTED_VERSION',
  );

  // The reader the resume path uses answers null for every one of those, never a throw.
  assert.equal(conversationLogChunks('{'), null);
  assert.equal(conversationLogChunks(''), null);
  assert.equal(conversationLogChunks(null), null);
  assert.deepEqual(
    conversationLogChunks(JSON.stringify({ version: CONVERSATION_LOG_VERSION, id: ID, chunks: [{ role: 'user' }] })),
    [{ role: 'user' }],
  );
});

test('the compaction shrinks the window and leaves the journal untouched', async () => {
  const window = windowWith(12);

  assert.equal(window.chunks.length, 12);
  assert.equal(window.journal.length, 12, 'the journal starts in step with the window');

  const before = window.journal.slice();
  await window.compact({
    force: true,
    callModel: async () => 'SUMMARY: the first stretch of work',
  });

  assert.ok(window.chunks.length < 12, 'the window was compacted');
  assert.equal(window.chunks[0].compacted, true);
  // The whole point: every chunk, all the way back, is still there — same objects, in order.
  assert.equal(window.journal.length, 12);
  assert.deepEqual(window.journal, before);
  assert.equal(window.stats().journalChunks, 12, 'the stats report both sizes');

  // A chunk added after the compaction joins both, so the log keeps growing as the
  // conversation does.
  const fresh = { role: 'user', content: 'after the compaction' };
  window.add(fresh);
  assert.equal(window.journal.at(-1), fresh);
  assert.equal(window.journal.length, 13);
});

test('replace() restores the log a resumed session carried, and clear() empties both', () => {
  const window = new ContextWindow({ maxTokens: 100000 });
  const restored = [{ role: 'user', content: 'old, compacted away' }, { role: 'user', content: 'recent' }];

  window.replace([restored[1]], { journal: restored });
  assert.deepEqual(window.chunks, [restored[1]]);
  assert.deepEqual(window.journal, restored, 'the compacted-away chunk is back in the history');

  // A caller that only knows the window gets the window as its history, never nothing.
  window.replace(restored);
  assert.deepEqual(window.journal, restored);

  window.clear();
  assert.deepEqual(window.chunks, []);
  assert.deepEqual(window.journal, []);
});

test('conversation.json is written beside context.json and read back byte-for-byte', () => {
  const chunks = [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }];
  const written = writeConversationLog({ id: ID, chunks }, { dir: DIR });

  assert.equal(written.verified, true);
  assert.equal(written.path, conversationPath(ID, { dir: DIR }));
  assert.equal(conversationPath(ID, { dir: DIR }), `${DIR}/${ID}/conversation.json`);
  // The two files are siblings, and neither name is the other's.
  assert.equal(path.dirname(sessionPath(ID, { dir: DIR })), path.dirname(conversationPath(ID, { dir: DIR })));
  assert.notEqual(sessionPath(ID, { dir: DIR }), conversationPath(ID, { dir: DIR }));

  assert.equal(hasConversationLog(ID, { dir: DIR }), true);
  assert.deepEqual(readConversationLog(ID, { dir: DIR }), chunks);
});

test('a missing or unreadable log answers null, so a resume is never blocked', () => {
  assert.equal(hasConversationLog('never-written', { dir: DIR }), false);
  assert.equal(readConversationLog('never-written', { dir: DIR }), null);

  writeConversationLog({ id: 'broken', chunks: [{ role: 'user' }] }, { dir: DIR });
  fs.writeFileSync(path.join(root, DIR, 'broken', 'conversation.json'), '{"version":99,"id":"broken","chunks":[]}\n');
  assert.equal(hasConversationLog('broken', { dir: DIR }), true);
  assert.equal(readConversationLog('broken', { dir: DIR }), null, 'an unknown version is no history, not an error');
});

test('every session save writes the uncompacted history with it', () => {
  const dir = 'recorder';
  const chunks = [{ role: 'user', content: 'the live window' }];
  const journal = [{ role: 'user', content: 'the first message, compacted away' }, ...chunks];
  const recorder = createSessionRecorder({ dir, model: 'test/model', now: () => new Date('2026-02-14T10:30:00Z') });

  const record = recorder.save(chunks, { journal });

  // The record is still what it was, plus the report of the log it wrote beside it.
  assert.equal(record.id, recorder.id);
  assert.equal(record.conversationLog.verified, true);
  assert.equal(record.conversationLog.path, conversationPath(recorder.id, { dir }));
  assert.equal(read(`${dir}/${recorder.id}/context.json`).includes('the live window'), true);

  const logged = JSON.parse(read(`${dir}/${recorder.id}/conversation.json`));
  assert.deepEqual(logged.chunks, journal, 'the history, not the window');
  assert.equal(logged.model, 'test/model');
  assert.equal(logged.id, recorder.id);

  // A caller that only knows the window (no journal) still writes a usable history.
  recorder.save(chunks, {});
  assert.deepEqual(JSON.parse(read(`${dir}/${recorder.id}/conversation.json`)).chunks, chunks);
});

test('the error class is the one callers catch', () => {
  const error = new ConversationLogError('INVALID_LOG', 'nope', { id: ID });
  assert.equal(error.name, 'ConversationLogError');
  assert.equal(error.code, 'INVALID_LOG');
  assert.deepEqual(error.details, { id: ID });
});
