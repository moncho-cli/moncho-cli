import test from 'node:test';
import assert from 'node:assert/strict';

import { busyVerdict, createBusyCommandRunner, isParallelCommand } from '../app/busy-command.js';
import { createDefaultCommands, createCommandRegistry } from '../app/commands.js';

const registry = createDefaultCommands();

test('busyVerdict() leaves a prompt alone, so the queue still holds it', () => {
  assert.equal(busyVerdict('please refactor the parser', { registry }), null);
  assert.equal(busyVerdict('   ', { registry }), null);
  // A bare slash is prose, exactly as parseCommand() treats it.
  assert.equal(busyVerdict('/ not a command', { registry }), null);
});

test('busyVerdict() runs a read-only command at once instead of queueing it', () => {
  for (const input of ['/task', '/task plan', '/help', '/usage']) {
    const verdict = busyVerdict(input, { registry });
    assert.equal(verdict.kind, 'run', input);
    assert.equal(verdict.command.busy, 'parallel', input);
  }
});

test('busyVerdict() refuses a command that mutates the conversation', () => {
  for (const input of ['/new', '/compact force', '/sessions', '/work on', '/ref', '/skins']) {
    const verdict = busyVerdict(input, { registry });
    assert.equal(verdict.kind, 'refuse', input);
    assert.match(verdict.message, /cannot run while a turn is in progress/);
  }
});

test('busyVerdict() refuses an unknown command without waiting for the turn', () => {
  const verdict = busyVerdict('/nope', { registry });
  assert.equal(verdict.kind, 'refuse');
  assert.equal(verdict.message, 'Unknown command /nope. Try /help.');
});

test('a command that declares nothing is deferred, so a new one cannot corrupt a live turn', () => {
  const bare = createCommandRegistry();
  bare.register({ name: 'unmarked', description: 'no declaration', run: () => ({ ok: true }) });
  assert.equal(isParallelCommand(bare.get('unmarked')), false);
  assert.equal(busyVerdict('/unmarked', { registry: bare }).kind, 'refuse');
});

test('the runner consumes a command and starts a parallel one without awaiting it', async () => {
  const ran = [];
  const notices = [];
  const runner = createBusyCommandRunner({
    registry,
    run: (input) => {
      ran.push(input);
      return Promise.resolve('done');
    },
    notify: (kind, text) => notices.push({ kind, text }),
  });

  assert.equal(runner('/task'), true);
  // Started asynchronously: the keystroke returns before the command resolves.
  assert.deepEqual(ran, []);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(ran, ['/task']);
  assert.deepEqual(notices, []);
});

test('the runner refuses a mutating command and never calls run()', () => {
  const ran = [];
  const notices = [];
  const runner = createBusyCommandRunner({
    registry,
    run: (input) => { ran.push(input); return Promise.resolve(); },
    notify: (kind, text) => notices.push({ kind, text }),
  });

  assert.equal(runner('/new'), true);
  assert.deepEqual(ran, []);
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /cannot run while a turn is in progress/);
});

test('the runner hands a prompt back to the queue, consumed by nobody', () => {
  const runner = createBusyCommandRunner({ registry, run: () => Promise.resolve() });
  assert.equal(runner('a real prompt'), false);
});

test('a command that throws is reported, never thrown into the keystroke', async () => {
  const notices = [];
  const runner = createBusyCommandRunner({
    registry,
    run: () => Promise.reject(new Error('modal exploded')),
    notify: (kind, text) => notices.push({ kind, text }),
  });

  assert.equal(runner('/help'), true);
  // A macrotask, not a counted number of microtasks: the handler is deliberately started
  // and forgotten, so the test waits for the tick to drain rather than guessing how many
  // promise hops the chain takes.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'error');
  assert.match(notices[0].text, /modal exploded/);
});

test('a front end with no way to run a command refuses instead of pretending', () => {
  const notices = [];
  const runner = createBusyCommandRunner({
    registry,
    run: null,
    notify: (kind, text) => notices.push({ kind, text }),
  });
  assert.equal(runner('/help'), true);
  assert.match(notices[0].text, /cannot run in this front end/);
});