import test from 'node:test';
import assert from 'node:assert/strict';

import { runSessionLoop, handleCommand, isExitInput, isAbortError } from '../app/session-loop.js';
import { createCommandRegistry } from '../app/commands.js';
import { workCommand } from '../app/work-command.js';
import { createSessionMode, MODES } from '../app/session-mode.js';

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

test('runSessionLoop() turns a whole queued batch into one turn', async () => {
  const pending = ['steer left', 'and also check the tests'];
  const turns = [];
  const cli = scriptedCli(['exit']);

  const result = await runSessionLoop({
    cli,
    log: () => {},
    manager: { processInput: async (input) => turns.push(input) },
    commands: createCommandRegistry(),
    abortManager: noopAbort(),
    saveSession: () => {},
    // A front end with the batch drain: both notes leave the queue together.
    tui: {
      drainAll: () => {
        const drained = pending.splice(0, pending.length);
        return drained;
      },
      dequeue: () => pending.shift() ?? null,
      startSpinner() {},
      stopSpinner() {},
    },
  });

  assert.equal(result, 'exit');
  // One turn, carrying both messages in order, separated by a blank line.
  assert.deepEqual(turns, ['steer left\n\nand also check the tests']);
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

test('runSessionLoop() ends on a command that asks to close, saving through the same path as exit', async () => {
  // `/upgrade` is the reason this exists: the running container cannot become the version
  // it just pinned the session to, so the command ends the process and the save has to
  // land after it — once, on the same route the `exit` sentinel takes.
  const registry = createCommandRegistry();
  registry.register({
    name: 'done',
    description: 'end the session',
    run: () => ({ ok: true, code: 'UPGRADED', id: 'new-id', monchoVersion: '9.9.9', close: true, message: 'moved' }),
  });

  const saved = [];
  const adopted = [];
  const cli = scriptedCli(['/done', 'this must never run']);
  const sessions = { id: 'old-id', monchoVersion: '1.0.0', adopt: (id, options) => adopted.push([id, options]) };

  const result = await runSessionLoop({
    cli,
    log: () => {},
    manager: { processInput: async () => { throw new Error('the loop should have ended'); } },
    commands: registry,
    sessions,
    saveSession: (reason) => { saved.push(reason); return null; },
  });

  assert.equal(result, 'exit', 'the loop returns the same sentinel an explicit exit does');
  assert.deepEqual(adopted, [['new-id', { createdAt: undefined, pin: '9.9.9' }]], 'the recorder continues the moved session');
  assert.deepEqual(saved, ['exit'], 'the session was saved exactly once, on the way out');
  assert.equal(cli.asked.length, 1, 'nothing after the command was asked for');
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

test('handleCommand() hands the live session mode to a command, so /work moves the gate state', async () => {
  const registry = createCommandRegistry();
  registry.register(workCommand());
  // A locked session, so `/work off` needs no checklist on disk: the case is about the
  // wiring, not about whatever the real task.md happens to hold today.
  const mode = createSessionMode({ mode: MODES.WORK, work: true });
  const logged = [];

  const consumed = await handleCommand('/work off', {
    commands: registry,
    log: (line) => logged.push(line),
    mode,
  });

  assert.equal(consumed, true, 'a command never reaches the model');
  assert.equal(mode.work, false, 'the very object the tool gate reads was released');
  assert.equal(mode.mode, MODES.DESIGN, 'and it fell back to Design');
  assert.ok(logged.some((line) => line.includes('Work is off')));
});

test('handleCommand() restores the stored mode of a resumed session, the lock included', async () => {
  const registry = createCommandRegistry();
  // A `work:on` session: the lock is on, so `setMode()` would be refused. Resuming must
  // therefore *restore* the state rather than request it.
  const mode = createSessionMode({ mode: MODES.WORK, work: true });
  const order = [];
  registry.register({
    name: 'resume',
    description: 'resume',
    run: () => ({
      ok: true,
      code: 'RESUMED',
      message: 'Resumed s1.',
      resumed: { id: 's1', model: 'm', chunks: [{ role: 'user', content: 'hi' }] },
      resumedMode: { mode: MODES.DESIGN, work: false },
    }),
  });

  await handleCommand('/resume s1', {
    commands: registry,
    log: (line) => order.push(line),
    mode,
  });

  assert.equal(mode.mode, MODES.DESIGN, 'the stored mode was adopted, not refused');
  assert.equal(mode.work, false, 'and the lock came down with it');
});

test('handleCommand() leaves the mode alone when the session file stored none', async () => {
  const registry = createCommandRegistry();
  const mode = createSessionMode();
  registry.register({
    name: 'resume',
    description: 'resume',
    run: () => ({
      ok: true,
      code: 'RESUMED',
      message: 'Resumed s1.',
      resumed: { id: 's1', chunks: [] },
      resumedMode: null,
    }),
  });

  await handleCommand('/resume s1', { commands: registry, log: () => {}, mode });

  assert.equal(mode.mode, MODES.WORK, 'an old file restores nothing');
  assert.equal(mode.work, false);
});

test('runSessionLoop() saves the conversation in Chat too, because the host writes that file, not a tool', async () => {
  const saved = [];
  // The one file a Chat session still produces is its own session record
  // (docs/interface/modes, docs/runtime/session-store): the save is host code, so no
  // mode gates it. This case pins the corrected wording — "no tool writes" must never
  // be read as "nothing lands on disk".
  const mode = createSessionMode({ mode: MODES.CHAT });

  await runSessionLoop({
    cli: scriptedCli(['how would we refactor app/tui.js?']),
    log: () => {},
    manager: { processInput: async () => {} },
    commands: createCommandRegistry(),
    mode,
    saveSession: (reason) => saved.push(reason),
  });

  assert.equal(mode.mode, MODES.CHAT, 'the session stayed where the user put it');
  assert.deepEqual(saved, ['turn', 'exit'], 'the transcript is saved in every mode');
});
