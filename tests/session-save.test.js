import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createSessionSave } from '../app/session-save.js';
import { loadSession } from '../utils/session-store.js';

/**
 * The conversation's record as one object (`docs/runtime/session-store`): the recorder, the
 * save and the mid-turn throttle, extracted from `main.js` so the startup wiring stays
 * readable.
 *
 * The two rules these cases fix are the ones `main.js` depends on: the state and skin
 * readers are **live** (read on every save, never snapshotted at construction), and a save
 * that throws is reported and returns `null` rather than taking the turn down with it.
 */

const DIR = `agent/sessions-save-test-${process.pid}`;

const cleanup = () => {
  try {
    fs.rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* nothing to clean */
  }
};

/** A manager stand-in: the parts createSessionSave() actually reads. */
const fakeManager = (chunks = []) => ({
  chunks,
  contextWindow: {
    journal: chunks,
    stamps: chunks.map(() => null),
    stats: () => ({ total: chunks.length }),
  },
  usageTable: () => ({
    'test/model': {
      requests: 2, exactRequests: 2, estimatedRequests: 0,
      promptTokens: 10, completionTokens: 20, totalTokens: 30,
      thinkingMs: 100, toolMs: 50,
    },
  }),
});

test('a save carries the live mode, the live skin and the accounting table', () => {
  cleanup();
  try {
    let state = { mode: 'work', work: false };
    let skin = 'default';
    const chunks = [{ role: 'user', content: 'hello' }];

    const { sessions, saveSession } = createSessionSave({
      manager: fakeManager(chunks),
      model: 'test/model',
      stateOf: () => state,
      skinOf: () => skin,
      dir: DIR,
    });

    const record = saveSession('turn');
    assert.ok(record, 'the save answered the record');
    assert.equal(record.session.skin, 'default', 'the skin in force was written');

    const stored = loadSession(sessions.id, { dir: DIR });
    assert.equal(stored.mode, 'work');
    assert.equal(stored.skin, 'default');
    assert.deepEqual(stored.chunks, chunks, 'the window is stored verbatim');
    assert.equal(stored.usage['test/model'].totalTokens, 30, 'the accounting table travelled with the record');
    assert.equal(stored.usage['test/model'].requests, 2);

    // The readers are live: the next save carries the *new* state and skin, not the ones
    // that were in force when the object was built.
    state = { mode: 'design', work: false };
    skin = 'matrix';
    saveSession('turn');

    const after = loadSession(sessions.id, { dir: DIR });
    assert.equal(after.mode, 'design', 'the live mode reader was used');
    assert.equal(after.skin, 'matrix', 'the live skin reader was used');
  } finally {
    cleanup();
  }
});

test('a save that throws is reported and returns null instead of taking the turn down', () => {
  const reported = [];
  const lines = [];
  const { saveSession } = createSessionSave({
    // A manager whose window cannot be serialised: the save throws.
    manager: {
      chunks: 'not-an-array',
      contextWindow: {
        journal: [],
        stamps: [],
        stats: () => { throw new Error('the window is broken'); },
      },
      usageTable: () => ({}),
    },
    dir: DIR,
    logger: { error: (scope, message) => reported.push({ scope, message }) },
    log: (line) => lines.push(line),
  });

  assert.equal(saveSession('turn'), null, 'the failure is contained');
  assert.equal(reported.length, 1, 'the operational log recorded it');
  assert.equal(reported[0].scope, 'session');
  assert.match(lines.join('\n'), /Could not save/, 'the user was told on screen');
});

test('the throttle is inert until started, and writes once started', () => {
  cleanup();
  try {
    const { autosave, sessions } = createSessionSave({
      manager: fakeManager([{ role: 'user', content: 'hi' }]),
      dir: DIR,
    });

    // Before start() every method is a null-safe no-op: main.js hands the handle to the
    // loop before the throttle exists.
    assert.doesNotThrow(() => autosave.touch('chunk'));
    assert.doesNotThrow(() => autosave.settle());
    assert.equal(sessions.saves, 0, 'nothing was written yet');

    const throttle = autosave.start();
    assert.ok(throttle, 'start() answered the real throttle');
    autosave.touch('chunk');
    autosave.settle();
    assert.equal(sessions.saves, 1, 'the started throttle wrote the window');

    assert.doesNotThrow(() => autosave.close());
  } finally {
    cleanup();
  }
});
