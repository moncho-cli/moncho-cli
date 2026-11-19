import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createSessionAutosave, AUTOSAVE_INTERVAL_MS } from '../app/session-autosave.js';
import { createSessionRecorder } from '../app/session-recorder.js';
import { ConversationManager } from '../app/conversation-manager.js';
import { runSessionLoop } from '../app/session-loop.js';
import { createCommandRegistry } from '../app/commands.js';
import { loadSession } from '../utils/session-store.js';

/**
 * Writing the session record while the conversation happens.
 *
 * The bug these cases pin: `context.json` was read back correctly but only ever written
 * when a *turn* ended, so a turn that took minutes — or one the process never finished —
 * left a record that knew nothing about the messages already exchanged. The rules are a
 * leading-edge throttle around the recorder's own `save()`, so they are provable with an
 * injected clock and timer instead of a real sleep.
 */

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const tempDir = (name) => {
  const dir = `agent/sessions-test-${process.pid}-${name}`;
  return cleanup(dir) ?? dir;
};

/** A clock and a timer a test advances by hand: `timer.advance(ms)` runs due callbacks. */
function fakeTimers(start = 0) {
  let time = start;
  const scheduled = new Map();
  let nextId = 0;
  return {
    now: () => time,
    arm(fn, ms) {
      const id = ++nextId;
      scheduled.set(id, { fn, at: time + ms });
      return id;
    },
    disarm(id) {
      scheduled.delete(id);
    },
    /** Move the clock forward, running every callback that is now due. */
    advance(ms) {
      const target = time + ms;
      let guard = 0;
      for (;;) {
        const due = [...scheduled.entries()]
          .filter(([, job]) => job.at <= target)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0 || guard++ > 50) break;
        for (const [id, job] of due) {
          scheduled.delete(id);
          time = job.at;
          job.fn();
        }
      }
      time = target;
    },
    get pending() {
      return scheduled.size;
    },
  };
}

test('the first change is written at once, so the record exists as soon as a message lands', () => {
  const timers = fakeTimers();
  const ledger = [];
  const autosave = createSessionAutosave({
    save: (reason) => ledger.push({ reason, at: timers.now() }),
    now: timers.now,
    arm: timers.arm,
    disarm: timers.disarm,
  });

  assert.equal(autosave.touch('user'), true, 'the first chunk writes immediately');
  assert.deepEqual(ledger, [{ reason: 'user', at: 0 }]);
  assert.equal(autosave.writes, 1);
  assert.equal(autosave.pending, null, 'nothing is left queued by an immediate write');
  assert.equal(timers.pending, 0, 'and no timer was armed');
});

test('a burst inside the interval is coalesced into one trailing write', () => {
  const timers = fakeTimers();
  const ledger = [];
  const autosave = createSessionAutosave({
    save: (reason) => ledger.push({ reason, at: timers.now() }),
    intervalMs: 500,
    now: timers.now,
    arm: timers.arm,
    disarm: timers.disarm,
  });

  autosave.touch('user'); // immediate, t = 0
  // One tool batch: an assistant chunk plus one chunk per call, all in the same tick.
  assert.equal(autosave.touch('tools'), false, 'the burst does not write again');
  assert.equal(autosave.touch('reply'), false, 'and neither does the next chunk');
  assert.equal(timers.pending, 1, 'exactly one timer is armed for the whole burst');
  assert.equal(autosave.pending, 'reply', 'the last change wins');
  assert.deepEqual(ledger.map((entry) => entry.reason), ['user'], 'only one write so far');

  timers.advance(499);
  assert.equal(ledger.length, 1, 'the trailing write waits out the interval');
  timers.advance(1);
  assert.deepEqual(
    ledger.map((entry) => entry.reason),
    ['user', 'reply'],
    'the coalesced change is written once, under the last reason',
  );
  assert.equal(autosave.pending, null);

  // A change long after the last write is immediate again.
  timers.advance(1000);
  assert.equal(autosave.touch('reply'), true, 'the leading edge comes back');
  assert.equal(ledger.length, 3);
});

test('settle() drops the queued write, because a save already superseded it', () => {
  const timers = fakeTimers();
  const ledger = [];
  const autosave = createSessionAutosave({
    save: (reason) => ledger.push(reason),
    now: timers.now,
    arm: timers.arm,
    disarm: timers.disarm,
  });

  autosave.touch('user');
  autosave.touch('reply'); // queued
  assert.equal(timers.pending, 1);

  autosave.settle();
  assert.equal(autosave.pending, null);
  assert.equal(timers.pending, 0, 'the pending timer is cancelled');
  timers.advance(10_000);
  assert.deepEqual(ledger, ['user'], 'no duplicate write of the same window');

  // The window restarted at the save that superseded it, so the next chunk is due now.
  assert.equal(autosave.touch('user'), true, 'the next turn writes immediately again');
});

test('a save that throws is contained and reported, never thrown at the caller', () => {
  const autosave = createSessionAutosave({
    save: () => { throw new Error('disk full'); },
    now: () => 0,
  });

  assert.equal(autosave.touch('user'), true, 'the write was attempted');
  assert.equal(autosave.lastError?.message, 'disk full');
  assert.equal(autosave.lastRecord, null);
  assert.equal(autosave.writes, 1, 'the attempt is counted, so the throttle still holds');
});

test('close() stops the throttle for good, and a closed handle never writes again', () => {
  const timers = fakeTimers();
  const ledger = [];
  const autosave = createSessionAutosave({
    save: (reason) => ledger.push(reason),
    now: timers.now,
    arm: timers.arm,
    disarm: timers.disarm,
  });

  autosave.touch('user');
  autosave.touch('reply');
  autosave.close();
  assert.equal(autosave.isClosed, true);
  assert.equal(timers.pending, 0);
  assert.equal(autosave.touch('user'), false);
  timers.advance(10_000);
  assert.deepEqual(ledger, ['user']);
});

test('the manager announces a chunk change, and the recorder writes the file during the turn', async () => {
  const dir = tempDir('autosave-live');
  try {
    const saves = [];
    const recorder = createSessionRecorder({ dir, model: 'test-model', now: () => new Date('2026-03-01T10:00:00.000Z') });
    const autosave = createSessionAutosave({
      save: (reason) => {
        saves.push(reason);
        return recorder.save(manager.chunks, { reason });
      },
      // A zero-width interval keeps the test free of timers while still proving the
      // hook wiring: every change is written on the leading edge.
      intervalMs: 0,
    });

    // A model that calls one tool, then answers: the busiest shape a turn has.
    let calls = 0;
    const manager = new ConversationManager({}, () => [], () => null, {
      model: 'test-model',
      onChunksChange: (reason) => autosave.touch(reason),
      callModel: async () => {
        calls += 1;
        if (calls === 1) {
          return { message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'nope', arguments: '{}' } }] }, usage: {} };
        }
        return { message: { content: 'done' }, usage: {} };
      },
    });

    const onDisk = () => loadSession(recorder.id, { dir }).chunks.map((chunk) => chunk.role);
    assert.equal(recorder.saves, 0, 'nothing is written before the conversation starts');

    await manager.processInput('hello there');

    assert.ok(saves.includes('user'), 'the user chunk wrote the record immediately');
    assert.ok(saves.includes('tools'), 'the tool batch wrote it too');
    assert.ok(saves.includes('reply'), 'and so did the final reply');
    assert.deepEqual(onDisk(), ['user', 'assistant', 'tool', 'assistant'], 'the file holds the turn');
    autosave.close();
  } finally {
    cleanup(dir);
  }
});

test('the loop settles the throttle after its own save, so the record is never written twice', async () => {
  const dir = tempDir('autosave-loop');
  try {
    const recorder = createSessionRecorder({ dir, model: 'test-model' });
    const saves = [];
    const chunks = [{ role: 'user', content: 'hi' }];
    const timers = fakeTimers();
    // The manager is a stub here: the case is about the *loop's* save superseding the
    // queued one, not about the turn itself.
    const autosave = createSessionAutosave({
      save: (reason) => {
        saves.push(reason);
        return recorder.save(chunks, { reason });
      },
      now: timers.now,
      arm: timers.arm,
      disarm: timers.disarm,
    });

    // The first change of the session writes at once; everything inside the next
    // half-second is what the loop's own save has to supersede.
    autosave.touch('user');
    assert.equal(autosave.pending, null);

    const manager = {
      chunks,
      contextWindow: { stats: () => ({ chunks: 1 }), usage: () => '1%' },
      usageTable: () => ({}),
      processInput: async () => {
        // Mid-turn the conversation grew: the first change writes at once, and the next
        // one inside the interval is the change that gets queued.
        autosave.touch('reply');
        autosave.touch('tools');
        assert.equal(autosave.pending, 'tools');
      },
    };

    const asked = ['hello', 'exit'];
    await runSessionLoop({
      cli: {
        question: () => Promise.resolve(asked.shift() ?? 'exit'),
        exit() {},
      },
      log: () => {},
      manager,
      commands: createCommandRegistry(),
      autosave,
      saveSession: (reason) => {
        saves.push(reason);
        return recorder.save(chunks, { reason });
      },
    });

    // 'user' is the leading edge writing at once; 'tools' is the change the loop's own
    // save superseded, so it never produced a second write of the same bytes.
    assert.deepEqual(saves, ['user', 'turn', 'exit'], 'the queued mid-turn write was superseded, not repeated');
    assert.equal(autosave.pending, null);
    assert.equal(recorder.saves, 3, 'the file was written once per real save, never twice for one');
    autosave.close();
  } finally {
    cleanup(dir);
  }
});

test('the autosave interval is short enough to feel immediate and long enough to coalesce', () => {
  assert.equal(AUTOSAVE_INTERVAL_MS, 500);
  assert.ok(AUTOSAVE_INTERVAL_MS > 0 && AUTOSAVE_INTERVAL_MS <= 2000);
});
