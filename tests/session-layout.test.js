import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  SESSION_RECORD_FILE,
  formatSession,
  legacySessionPath,
  listSessions,
  loadSession,
  migrateSession,
  parseSession,
  serializeSession,
  sessionDir,
  sessionPath,
  writeSession,
} from '../utils/session-store.js';

/**
 * The **layout** of a stored conversation: one folder per session, with the
 * conversation itself in `context.json` beside the checklist and the plan that folder
 * already owns.
 *
 * These cases exist because the folder move once left the conversation writing a flat
 * `<id>.json` next to a `<id>/` folder of the same name — two things competing for one
 * path, so the record was never found again. The rule is now one path, one meaning, and
 * the older flat file is only ever *read* (and retired by the next save).
 */

function tempDir(name) {
  const dir = `agent/sessions-layout-${process.pid}-${name}`;
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

const CHUNKS = [
  { role: 'user', content: 'read the fixture' },
  { role: 'assistant', content: 'done' },
];

const ID = '2026-02-14T10-30-00-000Z';
/** The same moment as a Date: the id is the safe spelling, the record needs the date. */
const AT = () => new Date('2026-02-14T10:30:00.000Z');
const record = (extra = {}) => formatSession(serializeSession({ id: ID, createdAt: AT(), chunks: CHUNKS, ...extra }));

test('the conversation record lives inside the session folder, next to its tracking files', () => {
  assert.equal(SESSION_RECORD_FILE, 'context.json');
  assert.equal(sessionDir(ID), `agent/sessions/${ID}`);
  assert.equal(sessionPath(ID), `agent/sessions/${ID}/context.json`);

  // The folder is the only place a write goes, and the two tracking files share it.
  const dir = tempDir('together');
  try {
    writeSession({ id: ID, createdAt: AT(), chunks: CHUNKS }, { dir });
    fs.writeFileSync(path.join(dir, ID, 'task.md'), '# Task list\n');

    assert.deepEqual(fs.readdirSync(path.join(dir, ID)).sort(), ['context.json', 'task.md']);
    assert.equal(fs.existsSync(path.join(dir, `${ID}.json`)), false, 'nothing is written beside the folder');
  } finally {
    cleanup(dir);
  }
});

test('a session stored by the older flat layout is still listed and loaded', () => {
  const dir = tempDir('legacy');
  try {
    // Exactly how the previous layout wrote it: `<dir>/<id>.json`, with no folder.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(legacySessionPath(ID, { dir }), record());

    const [summary] = listSessions({ dir });
    assert.equal(summary.id, ID);
    assert.equal(summary.layout, 'flat', 'the summary names the layout it came from');
    assert.deepEqual(loadSession(ID, { dir }).chunks, CHUNKS, 'the old record still resumes');
  } finally {
    cleanup(dir);
  }
});

test('when both layouts hold one id, the folder is the record that is listed and read', () => {
  const dir = tempDir('both');
  try {
    fs.mkdirSync(path.join(dir, ID), { recursive: true });
    fs.writeFileSync(path.join(dir, ID, SESSION_RECORD_FILE), record());
    fs.writeFileSync(
      legacySessionPath(ID, { dir }),
      formatSession(serializeSession({
        id: ID,
        createdAt: AT(),
        chunks: [{ role: 'user', content: 'stale' }],
      })),
    );

    const list = listSessions({ dir });
    assert.equal(list.length, 1, 'one id is one session, never two rows');
    assert.equal(list[0].layout, 'folder');
    assert.deepEqual(loadSession(ID, { dir }).chunks, CHUNKS, 'the folder copy wins, not the stale file');
  } finally {
    cleanup(dir);
  }
});

test('migrateSession() moves a flat record into its folder, byte for byte', () => {
  const dir = tempDir('migrate');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const flat = record({ model: 'ollama · qwen' });
    fs.writeFileSync(legacySessionPath(ID, { dir }), flat);

    assert.equal(migrateSession(ID, { dir }), true);
    assert.equal(
      fs.readFileSync(sessionPath(ID, { dir }), 'utf-8'),
      flat,
      'the bytes are re-laid-out, not re-serialised',
    );
    assert.equal(fs.existsSync(legacySessionPath(ID, { dir })), false, 'the old file is gone');
    assert.equal(migrateSession(ID, { dir }), false, 'a second migration has nothing to do');
    assert.equal(migrateSession('2020-01-01T00-00-00-000Z', { dir }), false);
  } finally {
    cleanup(dir);
  }
});

test('the next save retires the flat record, so one session keeps one record', () => {
  const dir = tempDir('retire');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      legacySessionPath(ID, { dir }),
      formatSession(serializeSession({
        id: ID,
        createdAt: AT(),
        chunks: [{ role: 'user', content: 'old' }],
      })),
    );

    writeSession({ id: ID, createdAt: AT(), chunks: CHUNKS }, { dir });

    assert.equal(fs.existsSync(legacySessionPath(ID, { dir })), false, 'the stale flat file is dropped by the save');
    assert.equal(parseSession(fs.readFileSync(path.join(dir, ID, SESSION_RECORD_FILE), 'utf-8')).chunks.length, 2);
    assert.equal(listSessions({ dir }).length, 1);
  } finally {
    cleanup(dir);
  }
});

test('a folder without context.json is not a session, and a broken record is reported', () => {
  const dir = tempDir('broken');
  try {
    writeSession({ id: ID, createdAt: AT(), chunks: CHUNKS }, { dir });
    // Something else in a session folder — a stray file, another session's copy — is
    // never mistaken for the conversation.
    fs.mkdirSync(path.join(dir, 'not-a-session'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'not-a-session', 'notes.md'), 'hello');
    assert.equal(listSessions({ dir }).length, 1);

    fs.writeFileSync(path.join(dir, ID, SESSION_RECORD_FILE), '{not json');
    const list = listSessions({ dir });
    assert.equal(list[0].error, 'INVALID_JSON');
    assert.throws(() => loadSession(ID, { dir }), (error) => error.code === 'INVALID_JSON');
  } finally {
    cleanup(dir);
  }
});