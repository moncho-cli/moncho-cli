import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  SESSION_DIR,
  SESSION_FORMAT_VERSION,
  SESSION_RECORD_FILE,
  SessionStoreError,
  sessionId,
  sessionPath,
  sessionDir,
  serializeSession,
  formatSession,
  parseSession,
  sessionChunks,
  countRoles,
  writeSession,
  listSessions,
  loadSession,
  latestSession,
  describeSession,
  sessionModeState,
  legacySessionPath,
  migrateSession,
} from '../utils/session-store.js';
import { createSessionRecorder } from '../app/session-recorder.js';

/** A throw-away sessions directory inside the project, cleaned up afterwards. */
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const tempDir = (name) => {
  const dir = `agent/sessions-test-${process.pid}-${name}`;
  return cleanup(dir) ?? dir;
};

const CHUNKS = [
  { role: 'system', content: 'you are moncho' },
  { role: 'user', content: 'read the fixture' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'call_0', function: { name: 'read_file', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'call_0', content: 'intent: read it\nfixture content' },
  { role: 'assistant', content: 'all done' },
];

test('sessions live under the gitignored agent/ tree by default', () => {
  assert.equal(SESSION_DIR, 'agent/sessions');
  // One conversation is one folder, and the conversation itself is context.json inside
  // it — next to the task.md / implementation_plan.md that folder already owns.
  assert.equal(sessionPath('2026-02-14T10-30-00-000Z'), 'agent/sessions/2026-02-14T10-30-00-000Z/context.json');
  assert.equal(SESSION_RECORD_FILE, 'context.json');
  // the agent/ tree is disposable by design: sessions never ship in a commit
  const ignore = fs.readFileSync('.gitignore', 'utf-8');
  // The rule must be root-anchored: a bare `agent/` would also hide the docs
  // realm's docs/agent/ specs, which are meant to ship.
  assert.match(ignore, /^\/agent\/$/m, 'the root agent/ tree must stay gitignored');
  assert.doesNotMatch(ignore, /^agent\/$/m, 'an unanchored agent/ would hide docs/agent/ too');
});

test('sessionId() derives a sortable, date-named id from a Date', () => {
  const at = new Date('2026-02-14T10:30:00.000Z');
  assert.equal(sessionId(at), '2026-02-14T10-30-00-000Z');
  assert.ok(sessionId(new Date('2026-02-14T10:30:00.000Z')) < sessionId(new Date('2026-02-15T00:00:00.000Z')));
  assert.throws(() => sessionId('not a date'), (error) => error.code === 'INVALID_DATE');
});

test('sessionPath() refuses ids that could escape the sessions directory', () => {
  for (const bad of ['', '  ', '../escape', 'a/b', 'a\\b', null, undefined]) {
    assert.throws(
      () => sessionPath(bad),
      (error) => error instanceof SessionStoreError && error.code === 'INVALID_ID',
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
  assert.equal(sessionPath('ok', { dir: 'agent/sessions/' }), 'agent/sessions/ok/context.json');
});

test('sessionDir() names the folder that holds one session record', () => {
  assert.equal(sessionDir('2026-02-14T10-30-00-000Z'), 'agent/sessions/2026-02-14T10-30-00-000Z');
  // The record path is the folder plus the record name, so the two never drift apart.
  assert.equal(
    sessionDir('s1'),
    sessionPath('s1').replace(/\/context\.json$/, ''),
    'the record path is the folder plus context.json',
  );
  assert.equal(sessionDir('ok', { dir: 'agent/sessions/' }), 'agent/sessions/ok');

  // The same validation as sessionPath(): a folder can never become a traversal either.
  for (const bad of ['', '  ', '../escape', 'a/b', 'a\\b', null, undefined]) {
    assert.throws(
      () => sessionDir(bad),
      (error) => error instanceof SessionStoreError && error.code === 'INVALID_ID',
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test('serializeSession() records the metadata and the chunks verbatim', () => {
  const at = new Date('2026-02-14T10:30:00.000Z');
  const session = serializeSession({ createdAt: at, model: 'openrouter · test/model', chunks: CHUNKS });

  assert.equal(session.version, SESSION_FORMAT_VERSION);
  assert.equal(session.id, '2026-02-14T10-30-00-000Z', 'the id is the date name');
  assert.equal(session.createdAt, at.toISOString());
  assert.equal(session.updatedAt, session.createdAt);
  assert.equal(session.model, 'openrouter · test/model');
  assert.equal(session.counts.chunks, 5);
  assert.deepEqual(session.counts.roles, { system: 1, user: 1, assistant: 2, tool: 1 });
  assert.deepEqual(session.chunks, CHUNKS, 'the full context is stored, not a summary');

  // the copy is defensive: mutating the input must not change the record
  CHUNKS[0].content = 'mutated';
  assert.equal(session.chunks[0].content, 'you are moncho');
  CHUNKS[0].content = 'you are moncho';

  assert.equal(countRoles([]).user, undefined);
  assert.throws(() => serializeSession({ chunks: 'nope' }), (error) => error.code === 'INVALID_CHUNKS');
});

test('the file on disk is pretty-printed JSON ending in a newline', () => {
  const session = serializeSession({ createdAt: new Date('2026-02-14T10:30:00.000Z'), chunks: CHUNKS });
  const text = formatSession(session);
  assert.ok(text.endsWith('\n'));
  assert.match(text, /\n {2}"version": 1,\n/, 'indented, one key per line');
  assert.equal(parseSession(text).chunks.length, 5);
});

test('parseSession() rejects junk and unsupported versions instead of guessing', () => {
  const good = formatSession(serializeSession({ createdAt: new Date(), chunks: [] }));
  assert.equal(parseSession(good).version, SESSION_FORMAT_VERSION);

  assert.throws(() => parseSession('{oops'), (error) => error.code === 'INVALID_JSON');
  assert.throws(() => parseSession('[1,2]'), (error) => error.code === 'INVALID_SESSION');
  assert.throws(() => parseSession('{"version":99,"id":"x","chunks":[]}'), (error) => error.code === 'UNSUPPORTED_VERSION');
  assert.throws(() => parseSession('{"version":1,"chunks":[]}'), (error) => error.code === 'INVALID_SESSION');
  assert.throws(() => parseSession('{"version":1,"id":"x"}'), (error) => error.code === 'INVALID_SESSION');
});

test('writeSession()/loadSession() round-trip the full context byte-for-byte', () => {
  const dir = tempDir('roundtrip');
  try {
    const written = writeSession({
      createdAt: new Date('2026-02-14T10:30:00.000Z'),
      model: 'ollama · qwen',
      chunks: CHUNKS,
      stats: { usage: '1.2k / 8.0k tokens (15%)' },
    }, { dir });

    assert.equal(written.verified, true);
    assert.equal(written.id, '2026-02-14T10-30-00-000Z');
    assert.equal(fs.readFileSync(written.path, 'utf-8'), formatSession(loadSession(written.id, { dir })));

    const loaded = loadSession(written.id, { dir });
    assert.deepEqual(sessionChunks(loaded), CHUNKS, 'the chunks survive the round-trip');
    assert.equal(loaded.stats.usage, '1.2k / 8.0k tokens (15%)');
    assert.equal(loaded.model, 'ollama · qwen');

    assert.throws(
      () => loadSession('2020-01-01T00-00-00-000Z', { dir }),
      (error) => error.code === 'NOT_FOUND',
    );
  } finally {
    cleanup(dir);
  }
});

test('listSessions() reports the newest first and tolerates a broken file', () => {
  const dir = tempDir('list');
  try {
    assert.deepEqual(listSessions({ dir }), [], 'a missing directory lists nothing');

    writeSession({ createdAt: new Date('2026-02-14T10:00:00.000Z'), chunks: CHUNKS }, { dir });
    writeSession({ createdAt: new Date('2026-02-15T10:00:00.000Z'), chunks: CHUNKS.slice(0, 2) }, { dir });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');

    const list = listSessions({ dir });
    assert.equal(list.length, 3);
    // ids are date-named, so the sort is the lexicographic one (newest first);
    // a file whose name is not a date lands where its name sorts.
    assert.deepEqual(list.slice(0, 2).map((entry) => entry.id), [
      '2026-02-15T10-00-00-000Z',
      '2026-02-14T10-00-00-000Z',
    ]);
    assert.equal(list[0].counts.chunks, 2);
    assert.ok(list.some((entry) => entry.error === 'INVALID_JSON'), 'a broken file is reported, not thrown');

    // the summary line is what the picker shows
    assert.match(describeSession(list[1]), /2026-02-14T10-00-00-000Z — 1 turn\(s\), 5 chunk\(s\)/);
    assert.match(describeSession(list.find((entry) => entry.error)), /unreadable \(INVALID_JSON\)/);
    assert.equal(describeSession(null), '');
  } finally {
    cleanup(dir);
  }
});

test('latestSession() returns the newest readable session', () => {
  const dir = tempDir('latest');
  try {
    assert.equal(latestSession({ dir }), null);
    writeSession({ createdAt: new Date('2026-02-14T10:00:00.000Z'), chunks: CHUNKS }, { dir });
    writeSession({ createdAt: new Date('2026-02-15T10:00:00.000Z'), chunks: CHUNKS }, { dir });
    assert.equal(latestSession({ dir }).id, '2026-02-15T10-00-00-000Z');
  } finally {
    cleanup(dir);
  }
});

test('the session recorder snapshots the live window under a dated name', () => {
  const dir = tempDir('recorder');
  try {
    const recorder = createSessionRecorder({
      dir,
      model: 'openrouter · test/model',
      now: () => new Date('2026-02-14T10:30:00.000Z'),
    });

    assert.equal(recorder.id, '2026-02-14T10-30-00-000Z');
    assert.equal(recorder.path, `${dir}/2026-02-14T10-30-00-000Z/context.json`);
    assert.equal(recorder.saves, 0);
    assert.equal(recorder.saveIfUsed([], {}), null, 'an empty window is not worth a file');
    assert.equal(recorder.saves, 0);

    const first = recorder.save(CHUNKS, { reason: 'turn' });
    assert.equal(first.verified, true);
    assert.equal(recorder.saves, 1);
    assert.equal(recorder.savedAt, '2026-02-14T10:30:00.000Z');
    assert.equal(first.session.stats && Object.keys(first.session.stats).length, 0);

    // a second save updates the same file with the longer context
    const longer = [...CHUNKS, { role: 'user', content: 'one more' }];
    recorder.save(longer, { reason: 'turn', stats: { usage: '2.0k / 8.0k tokens (25%)' } });
    assert.equal(recorder.saves, 2);

    const stored = loadSession(recorder.id, { dir });
    assert.equal(stored.counts.chunks, 6);
    assert.deepEqual(stored.chunks.at(-1), { role: 'user', content: 'one more' });
    assert.equal(stored.stats.usage, '2.0k / 8.0k tokens (25%)');
    assert.equal(listSessions({ dir }).length, 1, 'one conversation, one folder');

    const resumed = recorder.saveIfUsed(longer, { reason: 'exit' });
    assert.equal(resumed.id, recorder.id);
    assert.equal(recorder.saves, 3);
  } finally {
    cleanup(dir);
  }
});

test('a recorded session can be replayed into a context window', () => {
  const dir = tempDir('replay');
  try {
    const recorder = createSessionRecorder({ dir, now: () => new Date('2026-02-14T10:30:00.000Z') });
    recorder.save(CHUNKS, { reason: 'turn' });

    // what /sessions will do: list, pick one, load its chunks
    const [summary] = listSessions({ dir });
    const session = loadSession(summary.id, { dir });
    assert.deepEqual(sessionChunks(session), CHUNKS);
    assert.equal(session.id, summary.id);
  } finally {
    cleanup(dir);
  }
});

test('the mode and the lock sail with the session file, so a resumed session opens as it was left', () => {
  const dir = tempDir('mode');
  try {
    const recorder = createSessionRecorder({
      dir,
      now: () => new Date('2026-02-14T10:30:00.000Z'),
      stateOf: () => ({ mode: 'work', work: true }),
    });
    recorder.save(CHUNKS, { reason: 'turn' });

    const stored = loadSession(recorder.id, { dir });
    assert.equal(stored.mode, 'work');
    assert.equal(stored.work, true);
    assert.deepEqual(sessionModeState(stored), { mode: 'work', work: true });

    // A second recorder reads its state live, so a different state lands in its file.
    const other = createSessionRecorder({
      dir,
      now: () => new Date('2026-02-15T10:30:00.000Z'),
      stateOf: () => ({ mode: 'chat', work: false }),
    });
    other.save(CHUNKS, { reason: 'exit' });
    assert.deepEqual(sessionModeState(loadSession(other.id, { dir })), { mode: 'chat', work: false });
  } finally {
    cleanup(dir);
  }
});

test('a session file written before the mode existed still resumes', () => {
  const legacy = serializeSession({ createdAt: new Date('2026-02-14T10:30:00.000Z'), chunks: CHUNKS });
  assert.equal(sessionModeState(legacy), null, 'no stored state restores nothing');

  // A file that *does* carry a mode hands it back verbatim, junk included, so the
  // machine (not the store) decides that a corrupt value lands in chat.
  const odd = serializeSession({ createdAt: new Date('2026-02-14T10:30:00.000Z'), chunks: CHUNKS, mode: 'wrok' });
  assert.deepEqual(sessionModeState(odd), { mode: 'wrok', work: false });
});