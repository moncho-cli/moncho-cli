import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRunFlags, isHeadless, turnBudget, createFilePrompt,
  EXEC_FLAG, TURNS_FLAG, MODE_FLAG,
} from '../utils/run-flags.js';
import { runSessionLoop, askForPrompt } from '../app/session-loop.js';
import { createCommandRegistry } from '../app/commands.js';

/**
 * The headless one-shot (`docs/runtime/run-flags`).
 *
 * Two halves, proved apart because they fail apart: the flag parser is pure and is
 * driven directly, and the wiring is proved through `runSessionLoop` with a stub front
 * end and a stub manager — so no case here needs a pty, a provider or a sandbox.
 *
 * The refusals carry most of the weight. An argument a parser ignores is an argument a
 * caller believed was in force, and a benchmark that ran an unintended turn budget would
 * report a number that nothing in the number itself reveals as wrong.
 */

/** A front end answering a scripted list, recording every question it was asked. */
function scriptedCli(inputs = []) {
  const queue = [...inputs];
  return {
    asked: [],
    question() {
      const next = queue.length ? queue.shift() : 'exit';
      this.asked.push(next);
      return Promise.resolve(next);
    },
    exit() {},
    close() {},
  };
}

function noopAbort() {
  return { startTask() {}, endTask() {}, dispose() {} };
}

// ---------------------------------------------------------------------------
// parseRunFlags
// ---------------------------------------------------------------------------
test('--exec takes the next argument as the path to the prompt', () => {
  const flags = parseRunFlags([EXEC_FLAG, '/tmp/task.md']);
  assert.equal(flags.exec, '/tmp/task.md');
  assert.deepEqual(flags.errors, []);
});

test('--exec= accepts the path in the same argument', () => {
  const flags = parseRunFlags([`${EXEC_FLAG}=/tmp/task.md`]);
  assert.equal(flags.exec, '/tmp/task.md');
  // A path with an `=` in it must survive: the split is on the first one only.
  assert.equal(parseRunFlags([`${EXEC_FLAG}=/tmp/a=b.md`]).exec, '/tmp/a=b.md');
  assert.deepEqual(flags.errors, []);
});

test('--exec with no value is refused, and does not swallow the flag after it', () => {
  const flags = parseRunFlags([EXEC_FLAG, TURNS_FLAG, '3']);
  assert.equal(flags.exec, null, 'the missing path is not invented');
  assert.equal(flags.turns, 3, 'the flag after it is still parsed as itself');
  assert.equal(flags.errors.length, 1);
  assert.match(flags.errors[0], /needs a path/);

  assert.equal(parseRunFlags([EXEC_FLAG]).errors.length, 1);
  assert.equal(parseRunFlags([`${EXEC_FLAG}=`]).errors.length, 1);
});

test('--turns accepts a positive whole number and refuses zero, a negative and a fraction', () => {
  assert.equal(parseRunFlags([TURNS_FLAG, '1']).turns, 1);
  assert.equal(parseRunFlags([TURNS_FLAG, '12']).turns, 12);
  assert.equal(parseRunFlags([`${TURNS_FLAG}=7`]).turns, 7);

  for (const bad of ['0', '-1', '2.5', 'many', '']) {
    const flags = parseRunFlags([TURNS_FLAG, bad]);
    assert.equal(flags.errors.length, 1, `"${bad}" must be refused`);
    assert.match(flags.errors[0], /positive whole number/);
  }
});

test('--turns with no value is refused, and does not swallow the flag after it', () => {
  const flags = parseRunFlags([TURNS_FLAG, EXEC_FLAG, '/tmp/task.md']);
  assert.equal(flags.turns, null);
  assert.equal(flags.exec, '/tmp/task.md', 'the flag after it is still parsed as itself');
  assert.equal(flags.errors.length, 1);
  assert.match(flags.errors[0], /positive whole number/);
});

test('--mode names the mode the session opens in', () => {
  assert.equal(parseRunFlags([MODE_FLAG, 'design']).mode, 'design');
  assert.equal(parseRunFlags([`${MODE_FLAG}=chat`]).mode, 'chat');
  assert.equal(parseRunFlags([MODE_FLAG, 'work']).mode, 'work');
  assert.match(parseRunFlags([MODE_FLAG]).errors[0], /needs a mode/);
  // The value itself is not validated here: an unknown name resolves the way an unknown
  // name always does (app/session-mode.js#normalizeMode), rather than becoming a new
  // failure mode invented by the flag parser.
  assert.equal(parseRunFlags([MODE_FLAG, 'nonsense']).mode, 'nonsense');
  assert.deepEqual(parseRunFlags([MODE_FLAG, 'nonsense']).errors, []);
});

test('an unknown argument is refused rather than ignored', () => {
  // The dangerous shape: a near miss that would otherwise leave the run unbounded. Both
  // arguments are unknown, so both are reported — the count is not the point, the refusal
  // is.
  const flags = parseRunFlags(['--turn', '5']);
  assert.equal(flags.turns, null, 'the typo does not silently become a budget');
  assert.equal(flags.exec, null);
  assert.ok(flags.errors.length >= 1, 'the typo is refused');
  assert.ok(flags.errors.some((message) => /unknown argument/.test(message) && /--turn/.test(message)));

  // And the answer the caller needs is present: the run did not become bounded by accident.
  assert.equal(turnBudget(flags), 0, 'so the run is unbounded, not quietly bounded to 5');
});

test('the flags parse in any order and repeated flags take the last value', () => {
  const a = parseRunFlags([TURNS_FLAG, '3', MODE_FLAG, 'chat', EXEC_FLAG, '/a.md']);
  const b = parseRunFlags([EXEC_FLAG, '/a.md', MODE_FLAG, 'chat', TURNS_FLAG, '3']);
  assert.deepEqual(a, b, 'order does not change the result');

  const repeated = parseRunFlags([EXEC_FLAG, '/first.md', EXEC_FLAG, '/second.md']);
  assert.equal(repeated.exec, '/second.md');
  assert.deepEqual(repeated.errors, []);
});

// ---------------------------------------------------------------------------
// isHeadless and turnBudget
// ---------------------------------------------------------------------------
test('a run is headless when a prompt is named, and also when only a budget is given', () => {
  assert.equal(isHeadless(parseRunFlags([EXEC_FLAG, '/a.md'])), true);
  assert.equal(isHeadless(parseRunFlags([TURNS_FLAG, '3'])), true);
  assert.equal(isHeadless(parseRunFlags([MODE_FLAG, 'chat'])), false, 'a mode alone is not a headless run');
  assert.equal(isHeadless(parseRunFlags([])), false);
});

test('--exec bounds a process to one turn whatever --turns says', () => {
  // A file is not a queue: re-reading it would repeat the same task rather than continue
  // it, so the named prompt is the bound and `--turns` cannot raise it.
  assert.equal(turnBudget(parseRunFlags([EXEC_FLAG, '/a.md'])), 1);
  assert.equal(turnBudget(parseRunFlags([EXEC_FLAG, '/a.md', TURNS_FLAG, '5'])), 1);
  assert.equal(turnBudget(parseRunFlags([TURNS_FLAG, '5'])), 5);
});

test('a turn budget with no named prompt is passed through unchanged', () => {
  assert.equal(turnBudget(parseRunFlags([TURNS_FLAG, '9'])), 9);
  assert.equal(turnBudget(parseRunFlags([TURNS_FLAG, '1'])), 1);
  assert.equal(turnBudget(parseRunFlags([])), 0, '0 means unbounded');
});

// ---------------------------------------------------------------------------
// createFilePrompt
// ---------------------------------------------------------------------------
test('a named prompt is read verbatim, newlines and all', () => {
  const text = 'line one\n\n  indented two\n\n```sh\nmake test\n```\n';
  const read = [];
  const source = createFilePrompt({ file: '/task.md', readFile: (path) => { read.push(path); return text; } });
  assert.equal(source(), text, 'not trimmed, not split, not re-joined');
  assert.deepEqual(read, ['/task.md']);
});

test('the prompt file is read once, so a second call reports nothing left to run', () => {
  let reads = 0;
  const source = createFilePrompt({ file: '/task.md', readFile: () => { reads += 1; return 'do it'; } });
  assert.equal(source(), 'do it');
  assert.equal(source(), null, 'null is the "nothing more to run" answer');
  assert.equal(reads, 1, 'and the file is not read again');
});

test('an empty prompt file is refused instead of sending a turn with nothing in it', () => {
  for (const empty of ['', '   \n\n\t \n']) {
    const source = createFilePrompt({ file: '/task.md', readFile: () => empty });
    assert.throws(() => source(), /is empty/);
  }
});

// ---------------------------------------------------------------------------
// The wiring: runSessionLoop
// ---------------------------------------------------------------------------
test('runSessionLoop() asks the named prompt source before the front end', async () => {
  const cli = scriptedCli(['typed by a person']);
  const turns = [];
  const saved = [];
  const exec = createFilePrompt({ file: '/task.md', readFile: () => 'the named task' });

  const result = await runSessionLoop({
    cli,
    log: () => {},
    manager: { processInput: async (input) => turns.push(input) },
    commands: createCommandRegistry(),
    abortManager: noopAbort(),
    exec,
    saveSession: (reason) => saved.push(reason),
  });

  assert.equal(result, 'exit', 'a spent named prompt ends the run');
  assert.deepEqual(turns, ['the named task'], 'the named prompt was the only turn');
  assert.deepEqual(cli.asked, [], 'the keyboard was never consulted');
  // Two saves, exactly as a typed `exit` produces: the turn's, then the exit's. The
  // named prompt changes *where the exit came from*, not how the loop leaves.
  assert.deepEqual(saved, ['turn', 'exit']);
});

test('runSessionLoop() stops after the turn budget is spent', async () => {
  const cli = scriptedCli(['one', 'two', 'three', 'four']);
  const turns = [];
  const saved = [];

  const result = await runSessionLoop({
    cli,
    log: () => {},
    manager: { processInput: async (input) => turns.push(input) },
    commands: createCommandRegistry(),
    abortManager: noopAbort(),
    maxTurns: 2,
    saveSession: (reason) => saved.push(reason),
  });

  assert.equal(result, 'turns', 'the loop says why it stopped');
  assert.deepEqual(turns, ['one', 'two'], 'and it stopped at the budget, not past it');
  assert.deepEqual(saved, ['turn', 'turn'], 'the last turn is saved exactly once');
});

test('askForPrompt() prefers the named prompt, then the drive, then the front end', async () => {
  const exec = () => 'from the named file';
  assert.equal(await askForPrompt({ exec, drive: { next: () => ({ prompt: 'from the checklist' }) }, cli: scriptedCli([]) }),
    'from the named file');

  // Spent: the run is over, so it does NOT fall through to a keyboard that may not exist.
  assert.equal(await askForPrompt({ exec: () => null, drive: null, cli: null }), 'exit');

  // Without `--exec` the drive still outranks the keyboard.
  assert.equal(await askForPrompt({ drive: { next: () => ({ prompt: 'from the checklist' }) }, cli: scriptedCli(['typed']) }),
    'from the checklist');
});
