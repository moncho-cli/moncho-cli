import test from 'node:test';
import assert from 'node:assert/strict';

import { runSessionLoop, askForPrompt } from '../app/session-loop.js';
import { createCommandRegistry } from '../app/commands.js';
import { createWorkDrive, formatWorkPrompt, nextPendingItem, WORK_DRIVE_MAX_ATTEMPTS } from '../app/work-drive.js';
import { createSessionMode, MODES } from '../app/session-mode.js';

/**
 * The `work:on` self-drive: while the lock is on, the next prompt comes from `task.md`.
 *
 * These cases fix the three rules the lock is worth nothing without:
 *
 *  - the drive only speaks while the lock is engaged, read live;
 *  - a typed message still wins (the queue is drained before the drive is asked), so a
 *    chat message typed mid-run steers the next turn;
 *  - the same unchanged item is never handed over forever, so a stuck item cannot burn
 *    the budget silently.
 */

/** A `task.md` body with one checkbox per argument. */
const checklist = (...done) => done
  .map((ticked, i) => `- [${ticked ? 'x' : ' '}] item ${i + 1}`)
  .join('\n');

/** A locked session mode, plus the drive reading a fixed checklist. */
function harness({ done = [false], work = true, task = undefined } = {}) {
  const mode = createSessionMode({ mode: MODES.WORK, work });
  const logged = [];
  const drive = createWorkDrive({
    mode,
    readTask: () => (task === undefined ? checklist(...done) : task),
    log: (line) => logged.push(line),
  });
  return { mode, drive, logged };
}

test('the drive hands over the first pending item while the lock is on', () => {
  const { drive, logged } = harness({ done: [true, false, false] });

  const next = drive.next();

  assert.equal(next.attempt, 1);
  assert.equal(next.item.text, 'item 2', 'the first *pending* item, not the first item');
  assert.match(next.prompt, /task\.md/, 'the prompt names the tracking file');
  assert.match(next.prompt, /item 2/, 'and the item verbatim');
  assert.match(next.prompt, /update_task/, 'so the model knows how to make the drive move on');
  assert.ok(logged.some((line) => line.includes('2 item(s) pending')), 'the hand-out is on screen');
});

test('the drive stays silent while the lock is off, so the keyboard is in charge', () => {
  const { drive, mode } = harness({ work: false });

  assert.equal(drive.next(), null, 'no lock, no hand-out');
  mode.setWork(true);
  assert.ok(drive.next(), 'engaging the lock starts the drive on the next call');
});

test('a finished checklist stops the drive, and the lock stays on until /work off', () => {
  const { drive, mode } = harness({ done: [true, true] });

  assert.equal(drive.next(), null, 'nothing left to work through');
  assert.equal(drive.describe().stopped, 'done');
  assert.equal(mode.work, true, 'finishing the list is not a reason to release the lock');
  assert.equal(drive.next(), null, 'and it stays silent afterwards');
});

test('an unchanged item is handed over a bounded number of times', () => {
  const { drive, logged } = harness({ done: [false] });

  for (let i = 1; i <= WORK_DRIVE_MAX_ATTEMPTS; i += 1) {
    assert.ok(drive.next(), `attempt ${i} is allowed`);
  }

  assert.equal(drive.next(), null, 'the next attempt stands down');
  assert.equal(drive.describe().stopped, 'stalled');
  assert.ok(logged.some((line) => line.includes('still pending')), 'and says why');
  assert.equal(drive.next(), null, 'a stalled drive keeps quiet');

  // A reset lets the drive speak again, e.g. after the user typed a direction.
  drive.reset();
  assert.ok(drive.next(), 'a reset lets the drive speak again');
});

test('a different item clears the attempt count, so progress is not punished', () => {
  let body = checklist(false);
  const mode = createSessionMode({ mode: MODES.WORK, work: true });
  const drive = createWorkDrive({ mode, readTask: () => body });

  assert.equal(drive.next().attempt, 1);
  body = `${checklist(true)}\n- [ ] item 2`;
  assert.equal(drive.next().attempt, 1, 'a new item starts a fresh count');

  body = `${checklist(true)}\n- [x] item 2\n- [ ] item 3`;
  assert.equal(drive.next().item.text, 'item 3');
});

test('a missing task.md is told apart from an empty one, and neither drives', () => {
  const missing = harness({ task: null, done: [] });
  assert.equal(missing.drive.next(), null, 'no file, nothing to hand over');
  assert.equal(missing.drive.describe().stopped, null, 'a missing file is not a finished drive');

  assert.equal(nextPendingItem([{ text: 'a', done: true }]), null, 'an all-done list has no pending item');
  assert.match(formatWorkPrompt(null), /the next pending item/, 'a nameless item still reads sensibly');
});

test('askForPrompt() asks the drive first and the front end only when it is silent', () => {
  const asked = [];
  const cli = { question: (label) => { asked.push(label); return 'typed'; } };

  const driven = askForPrompt({ drive: { next: () => ({ prompt: 'work on item 2' }) }, cli });
  assert.equal(driven, 'work on item 2');
  assert.deepEqual(asked, [], 'the keyboard is not read while the drive has work');

  const fallback = askForPrompt({ drive: { next: () => null }, cli, tui: null });
  assert.equal(fallback, 'typed');
  assert.deepEqual(asked, ['\n> '], 'the line CLI prompt is the fallback');
});

test('runSessionLoop() runs the driven prompt as one normal turn, then the keyboard again', async () => {
  const turns = [];
  const mode = createSessionMode({ mode: MODES.WORK, work: true });
  let handed = 0;
  const drive = {
    next: () => {
      handed += 1;
      return handed === 1
        ? { prompt: 'work through item 1', item: { text: 'item 1' }, attempt: 1 }
        : null;
    },
  };
  const questions = [];
  const cli = {
    question() {
      questions.push('asked');
      return 'exit';
    },
    exit() {},
    close() {},
  };

  await runSessionLoop({
    cli,
    log: () => {},
    manager: { processInput: async (input) => turns.push(input) },
    commands: createCommandRegistry(),
    mode,
    drive,
    saveSession: () => {},
  });

  assert.deepEqual(turns, ['work through item 1'], 'the driven prompt is a normal turn');
  assert.equal(questions.length, 1, 'the keyboard is read once, after the drive stood down');
});

test('a queued message still steers the drive: the queue is drained first', async () => {
  const turns = [];
  const queued = ['steer it left'];
  let handed = false;
  const drive = {
    next: () => {
      if (handed) return null;
      handed = true;
      return { prompt: 'work through item 1', item: { text: 'item 1' }, attempt: 1 };
    },
  };

  await runSessionLoop({
    cli: { question: () => 'exit', exit() {}, close() {} },
    log: () => {},
    manager: { processInput: async (input) => turns.push(input) },
    commands: createCommandRegistry(),
    drive,
    tui: { dequeue: () => (queued.length ? queued.shift() : null), startSpinner() {}, stopSpinner() {} },
    saveSession: () => {},
  });

  assert.deepEqual(
    turns,
    ['steer it left', 'work through item 1'],
    'the typed message is the *first* prompt: the queue is drained before the drive is asked',
  );
});