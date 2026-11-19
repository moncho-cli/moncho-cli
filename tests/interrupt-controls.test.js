import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { AbortManager } from '../app/abort-manager.js';
import { createCLI } from '../app/cli.js';
import { createTui } from '../app/tui.js';

/** The decoder shapes and the pure key predicates live in tests/key-shapes.test.js. */

/** Minimal readline-shaped stub; records the questions AbortManager asks. */
function fakeRl() {
  const asked = [];
  return {
    asked,
    closed: false,
    listeners: {},
    on(event, handler) {
      (this.listeners[event] ||= []).push(handler);
      return this;
    },
    removeListener(event, handler) {
      this.listeners[event] = (this.listeners[event] || []).filter((h) => h !== handler);
      return this;
    },
    emit(event, ...args) {
      for (const handler of this.listeners[event] || []) handler(...args);
    },
    question(prompt, callback) {
      asked.push({ prompt, callback });
    },
    close() {
      this.closed = true;
    },
  };
}

test('AbortManager: no task means an interrupt is an exit request, exactly once', () => {
  const exits = [];
  const manager = new AbortManager(null, { onExit: () => exits.push('exit'), captureKeys: false });

  assert.equal(manager.hasActiveTask, false);
  assert.equal(manager.interrupt(), true);
  assert.deepEqual(exits, ['exit']);
  // A second press while the app is already leaving must not request it again.
  assert.equal(manager.interrupt(), false);
  assert.deepEqual(exits, ['exit']);

  manager.dispose();
});

test('AbortManager: no onExit means an idle interrupt is ignored, not a crash', () => {
  const manager = new AbortManager(null, { captureKeys: false });
  assert.equal(manager.interrupt(), false);
  manager.dispose();
});

test('AbortManager: an exit the host could not deliver is not latched', () => {
  let calls = 0;
  const manager = new AbortManager(null, {
    // The gap between two prompts: the host has no armed question to settle.
    onExit: () => {
      calls += 1;
      return false;
    },
    captureKeys: false,
  });

  assert.equal(manager.interrupt(), false);
  assert.equal(manager.interrupt(), false, 'still willing to try again');
  assert.equal(calls, 2, 'the host is asked every time');
  manager.dispose();
});

test('AbortManager (keys mode): first interrupt arms, second cancels', () => {
  const logs = [];
  const manager = new AbortManager(null, {
    confirmMode: 'keys',
    log: (text) => logs.push(text),
    captureKeys: false,
  });

  const signal = manager.startTask();
  assert.equal(manager.hasActiveTask, true);
  assert.equal(signal.aborted, false);

  assert.equal(manager.interrupt(), true, 'first press arms the confirmation');
  assert.equal(signal.aborted, false, 'arming must not abort');
  assert.equal(manager.isCancelled, false);
  assert.ok(logs.some((l) => /again to cancel/.test(l)));

  assert.equal(manager.interrupt(), true, 'second press cancels');
  assert.equal(signal.aborted, true);
  assert.equal(manager.isCancelled, true);
  assert.equal(manager.hasActiveTask, false);

  manager.dispose();
});

test('AbortManager: a cancelled task swallows further interrupts until endTask', () => {
  const exits = [];
  const manager = new AbortManager(null, {
    confirmMode: 'keys',
    log: () => {},
    onExit: () => exits.push('exit'),
    captureKeys: false,
  });

  manager.startTask();
  manager.interrupt();
  manager.interrupt();
  assert.equal(manager.isCancelled, true);

  // While the abort unwinds through the host loop a third press must not exit.
  assert.equal(manager.interrupt(), false);
  assert.deepEqual(exits, []);

  manager.endTask();
  assert.equal(manager.interrupt(), true, 'idle again -> exit');
  assert.deepEqual(exits, ['exit']);
  manager.dispose();
});

test('AbortManager (prompt mode): the y/N question decides the cancellation', () => {
  const rl = fakeRl();
  const logs = [];
  const manager = new AbortManager(rl, { confirmMode: 'prompt', log: (t) => logs.push(t) });

  const signal = manager.startTask();
  assert.equal(manager.interrupt(), true);
  assert.equal(rl.asked.length, 1, 'the CLI is asked on the readline interface');

  rl.asked[0].callback(' n ');
  assert.equal(signal.aborted, false, 'anything but yes keeps the task running');
  assert.ok(logs.some((l) => /Continuing task/.test(l)));

  manager.interrupt();
  rl.asked[1].callback('y');
  assert.equal(signal.aborted, true);
  manager.dispose();
});

test('AbortManager: ^C arrives as the readline SIGINT event, not a second keypress', () => {
  const rl = fakeRl();
  const manager = new AbortManager(rl, { confirmMode: 'keys', log: () => {}, captureKeys: false });

  manager.startTask();
  rl.emit('SIGINT');
  assert.equal(manager.isCancelled, false, 'first ^C only arms');
  rl.emit('SIGINT');
  assert.equal(manager.isCancelled, true, 'second ^C cancels');

  manager.dispose();
  assert.equal((rl.listeners.SIGINT || []).length, 0, 'dispose detaches the listener');
});

test('createCLI().exit() settles the pending question with the exit sentinel', async () => {
  // createCLI builds its own interface over process.stdin; exercise the real one.
  const real = createCLI();
  const pendingAnswer = real.question('> ');

  assert.equal(real.exit(), true, 'an armed question is settled');
  assert.equal(await pendingAnswer, 'exit');
  assert.equal(real.exit(), false, 'nothing armed anymore');
  real.close();
});

function fakeTty({ isTTY = true, columns = 80, rows = 24 } = {}) {
  const stream = new PassThrough();
  stream.isTTY = isTTY;
  stream.columns = columns;
  stream.rows = rows;
  return stream;
}

/** Build a TUI on fake TTYs and always tear it down. */
async function withTui(fn, options = {}) {
  const input = fakeTty();
  const output = fakeTty();
  output.resume();
  const tui = createTui({ input, output, modelLabel: 'probe', ...options });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    return await fn(tui);
  } finally {
    if (tui) tui.close();
    input.destroy();
    output.destroy();
  }
}

test('TUI: program-level Escape/Ctrl+C reach onInterrupt and leave the input box reading', async () => {
  let interrupts = 0;
  await withTui(async (tui) => {
    const armed = tui.question('> ');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tui.inputBox._reading, true);

    // The real dispatch path: the terminal decodes, the program re-emits.
    tui.screen.program.emit('keypress', null, { full: 'escape', name: 'escape' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(interrupts, 1, 'Escape was forwarded');
    assert.equal(tui.inputBox._reading, true, 'the box keeps reading (no textarea cancel)');
    assert.equal(tui.screen.lockKeys, false, 'the one-event key lock is released');

    tui.screen.program.emit('keypress', '\x03', { full: 'C-c', name: 'c', ctrl: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(interrupts, 2, 'Ctrl+C was forwarded too');

    // The armed question is untouched: typed characters still land in the box.
    tui.inputBox.emit('keypress', 'h', { name: 'h', full: 'h' });
    assert.equal(tui.inputBox.getValue(), 'h');

    tui.inputBox.emit('submit', 'hello');
    assert.equal(await armed, 'hello');
  }, { onInterrupt: () => { interrupts += 1; } });
});

test('TUI: interrupts are forwarded while no question is armed (a task runs)', async () => {
  let interrupts = 0;
  await withTui(async (tui) => {
    const armed = tui.question('> ');
    tui.inputBox.emit('submit', 'go');
    assert.equal(await armed, 'go');

    tui.screen.program.emit('keypress', '\x1b', { name: 'escape', full: 'escape' });
    tui.screen.program.emit('keypress', '\x03', { name: 'c', ctrl: true, full: 'C-c' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(interrupts, 2);
  }, { onInterrupt: () => { interrupts += 1; } });
});

test('TUI: without an onInterrupt hook the keys are still swallowed, never fatal', async () => {
  await withTui(async (tui) => {
    const armed = tui.question('> ');
    await new Promise((resolve) => setImmediate(resolve));
    tui.screen.program.emit('keypress', '\x1b', { name: 'escape', full: 'escape' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tui.inputBox._reading, true);
    tui.inputBox.emit('submit', 'still here');
    assert.equal(await armed, 'still here');
  });
});

test('TUI: exit() resolves an armed question with the exit sentinel', async () => {
  await withTui(async (tui) => {
    assert.equal(tui.exit(), false, 'nothing armed yet');

    const armed = tui.question('> ');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tui.exit(), true);
    assert.equal(await armed, 'exit');
    assert.equal(tui.exit(), false, 'only one question can be settled');
  });
});

test('TUI: scrolling keys still work next to the interrupt forwarding', async () => {
  await withTui(async (tui) => {
    for (let i = 0; i < 200; i += 1) tui.log(`line ${i}`);
    tui.transcript.setScrollPerc(100);
    const bottom = tui.transcript.getScroll();

    tui.screen.emit('keypress', null, { name: 'pageup', full: 'pageup' });
    assert.ok(tui.transcript.getScroll() < bottom, 'pageup still scrolls up');
    tui.screen.emit('keypress', null, { name: 'end', full: 'end' });
    assert.equal(tui.transcript.getScrollPerc(), 100);
  });
});
