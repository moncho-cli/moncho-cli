import test from 'node:test';
import assert from 'node:assert/strict';

import { runSessionLoop, handleCommand, isExitInput, isAbortError } from '../app/session-loop.js';
import { createCommandRegistry } from '../app/commands.js';

/**
 * The host turn loop, extracted from main.js.
 *
 * These cases drive the loop with a stub front end and a stub manager, so the
 * behaviours that used to be reachable only through a whole session are proven
 * directly: where the prompt comes from, what an `exit` does, how a command is
 * answered, and that an abort ends the turn quietly while the `finally` block still
 * tears the task down.
 *
 * Every scripted front end ends with `exit`: the loop only stops on that sentinel,
 * so a stub that keeps answering would keep the loop running.
 */

/** A front end answerning a scripted list of inputs, then `exit`. */
function scriptedCli(inputs) {
  const queue = [...inputs];
  return {
    asked: [],
    question() {
      this.asked.push(queue[0] ?? 'exit');
      return Promise.resolve(queue.length ? queue.shift() : 'exit');
    },
    exit() {},
    close() {},
  };
}

function noopAbort() {
  const calls = [];
  return {
    calls,
    startTask: () => calls.push('start'),
    endTask: () => calls.push('end'),
    dispose: () => calls.push('dispose'),
  };
}

test('isExitInput() and isAbortError() recognise the sentinels both front ends emit', () => {
  assert.equal(isExitInput('exit'), true);
  assert.equal(isExitInput('  EXIT  '), true);
  assert.equal(isExitInput('exit now'), false);
  assert.equal(isExitInput(''), false);

  assert.equal(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  assert.equal(isAbortError({ code: 'ABORTED' }), true);
  assert.equal(isAbortError(new Error('Request was aborted')), true);
  assert.equal(isAbortError(new Error('boom')), false);
});

test('runSessionLoop() drains the queue before asking, runs one turn and saves it', async () => {
  const pending = ['queued from the queue'];
  const cli = scriptedCli(['typed at the prompt']);
  const logged = [];
  const turns = [];
  const saved = [];
  const abort = noopAbort();

  const result = await runSessionLoop({
    cli,
    log: (line) => logged.push(line),
    manager: { processInput: async (input) => turns.push(input) },
    commands: createCommandRegistry(),
    abortManager: abort,
    saveSession: (reason) => saved.push(reason),
    // The queue is the TUI's dequeue(): a scripted FIFO here.
    tui: { dequeue: () => (pending.length ? pending.shift() : null), startSpinner() {}, stopSpinner() {} },
  });

  assert.equal(result, 'exit');
  assert.deepEqual(turns, ['queued from the queue', 'typed at the prompt']);
  assert.deepEqual(saved, ['turn', 'turn', 'exit']);
  assert.deepEqual(abort.calls, ['start', 'end', 'start', 'end']);
  assert.ok(logged.includes('Exiting...'));
});

test('runSessionLoop() answers a command without calling the model', async () => {
  const registry = createCommandRegistry();
  registry.register({
    name: 'ping',
    description: 'say pong',
    run: () => ({ ok: true, code: 'PING', message: 'pong' }),
  });

  const turns = [];
  const logged = [];
  const cli = scriptedCli(['/ping']);

  await runSessionLoop({
    cli,
    log: (line) => logged.push(line),
    manager: { processInput: async (input) => turns.push(input) },
    commands: registry,
  });

  assert.deepEqual(turns, [], 'a command never reaches the model');
  assert.ok(logged.some((line) => line.includes('pong')), 'the command result is printed');
});

test('runSessionLoop() swallows an abort, keeps going, and always tears the task down', async () => {
  const logged = [];
  const saved = [];
  const abort = noopAbort();
  const cli = scriptedCli(['first']);

  await runSessionLoop({
    cli,
    log: (line) => logged.push(line),
    manager: {
      processInput: async () => {
        throw Object.assign(new Error('Request was aborted'), { name: 'AbortError' });
      },
    },
    commands: createCommandRegistry(),
    abortManager: abort,
    saveSession: (reason) => saved.push(reason),
  });

  assert.ok(logged.some((line) => line.includes('Task was aborted')), 'the abort is informational only');
  assert.deepEqual(saved, ['exit'], 'an aborted turn is not saved as a turn');
  assert.deepEqual(abort.calls, ['start', 'end'], 'the task is cleared in the finally block');
});

test('runSessionLoop() lets a real failure escape instead of hiding it', async () => {
  const cli = scriptedCli(['boom']);
  await assert.rejects(
    runSessionLoop({
      cli,
      manager: { processInput: async () => { throw new Error('provider exploded'); } },
      commands: createCommandRegistry(),
    }),
    /provider exploded/,
  );
});

test('handleCommand() resumes a session by reloading the view before printing', async () => {
  const registry = createCommandRegistry();
  const order = [];
  registry.register({
    name: 'resume',
    description: 'resume',
    run: () => ({
      ok: true,
      code: 'RESUMED',
      message: 'Resumed s1 (1 chunk(s)).',
      resumed: { id: 's1', model: 'm', chunks: [{ role: 'user', content: 'hi' }] },
    }),
  });

  const consumed = await handleCommand('/resume s1', {
    commands: registry,
    log: (line) => order.push(line),
    tui: { reload: () => order.push('reload') },
    manager: { chunks: [], contextWindow: { usage: () => '1%' } },
    sessions: { dir: '/tmp', adopt: (id) => order.push(`adopt:${id}`) },
  });

  assert.equal(consumed, true);
  assert.equal(order[0], 'reload', 'the view is replaced before the result is printed');
  assert.ok(order.includes('adopt:s1'), 'the recorder keeps saving into the resumed file');
});

test('handleCommand() returns false for a prompt and reports an unknown command', async () => {
  const registry = createCommandRegistry();
  const logged = [];

  assert.equal(await handleCommand('just a question', { commands: registry, log: () => {} }), false);

  const consumed = await handleCommand('/nope', { commands: registry, log: (line) => logged.push(line) });
  assert.equal(consumed, true);
  assert.ok(logged.some((line) => line.includes('Unknown command /nope')));
});
