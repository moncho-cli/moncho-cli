import test from 'node:test';
import assert from 'node:assert/strict';

import { FOCUS_CHECK_INTERVAL_MS, needsFocus, createFocusGuard } from '../app/focus-guard.js';
import { withTui } from './support/tui-harness.js';

/**
 * Keeping the input box armed (docs/interface/input-focus).
 *
 * The bug: a click on another region moved the focus off the textarea and blessed's
 * `blur` handler ended the box's read cycle, so every later keystroke was dropped and
 * there was no way back. The contract is two clauses -- "clicking should work" and
 * "periodically just put the focus back in there" -- and both are proven here against
 * the real TUI with program-level mouse events, plus the pure guard on its own.
 */

/** Flush neo-blessed's deferred repaints and its deferred read-listener install. */
const flush = async (rounds = 2) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A click at a screen cell, exactly as blessed's program reports one. */
async function click(tui, x, y) {
  tui.screen.program.emit('mouse', { x, y, action: 'mousedown' });
  tui.screen.program.emit('mouse', { x, y, action: 'mouseup' });
  await flush();
}

/** A cell inside a widget's border and padding. */
function cellOf(widget, row = 1) {
  return { x: widget.lpos.xi + 2, y: widget.lpos.yi + row };
}

/** How many 'keypress' listeners the textarea is carrying. */
function listenerCount(box) {
  const raw = box._events?.keypress;
  if (!raw) return 0;
  return Array.isArray(raw) ? raw.length : 1;
}

/**
 * Whether the box is fully armed: the focus, the read cycle **and** its listener.
 *
 * The listener is the third fact and it arrives a tick late: `readInput()` sets
 * `_reading = true` synchronously and installs the keypress listener from a
 * `nextTick` (`lib/widgets/textarea.js#Textarea`), so a box can be focused and
 * reading while still deaf for one tick. Waiting on the focus alone therefore
 * returns mid-install and reads as "zero listeners" — the race that made this
 * suite flake. The contract is the whole armed state, so that is what is awaited.
 */
function armed(tui) {
  return tui.screen.focused === tui.inputBox
    && tui.inputBox._reading === true
    && listenerCount(tui.inputBox) === 1;
}

/** Wait until `predicate()` is true, or fail the test with the elapsed time. */
async function waitFor(predicate, timeoutMs = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return -1;
}

/** A stand-in textbox: the guard only needs the focus, the read flag and an arm hook. */
function fakeBox({ focused = true, reading = true, locked = false } = {}) {
  const screen = { focused: null, lockKeys: locked };
  const box = {
    screen,
    _reading: reading,
    focusCalls: 0,
    readCalls: 0,
    focus() {
      box.focusCalls += 1;
      screen.focused = box;
    },
    readInput() {
      box.readCalls += 1;
      box._reading = true;
    },
  };
  screen.focused = focused ? box : null;
  return box;
}

/** A timer the tests drive by hand, so no clock is ever waited on. */
function fakeTimer() {
  const timers = [];
  return {
    timers,
    set(fn, ms) {
      const handle = { fn, ms, unrefCalled: false, unref() { handle.unrefCalled = true; } };
      timers.push(handle);
      return handle;
    },
    clear(handle) {
      handle.cleared = true;
    },
    tick() {
      for (const handle of timers) if (!handle.cleared) handle.fn();
    },
  };
}

test('needsFocus() reports a missing focus or a dead read cycle', () => {
  assert.equal(needsFocus({ focused: true, reading: true }), false, 'armed and reading is fine');
  assert.equal(needsFocus({ focused: false, reading: true }), true, 'no focus, no keystrokes');
  assert.equal(needsFocus({ focused: true, reading: false }), true, 'focused but deaf');
  assert.equal(needsFocus({ focused: false, reading: false }), true, 'both halves missing');
  assert.equal(needsFocus(), true, 'nothing to go on means "repair it"');
  assert.equal(needsFocus({ focused: 'yes', reading: 1 }), true, 'only literal true counts');
});

test('createFocusGuard() re-arms a drifted box once and counts the repair', () => {
  const timer = fakeTimer();
  const box = fakeBox();
  const guard = createFocusGuard({ inputBox: box, hold: () => true, timer });

  assert.equal(guard.ensure(), false, 'an armed box needs no repair');
  assert.equal(guard.repairs, 0);

  box.screen.focused = null; // the click on another region took the caret away
  box._reading = false; // and the blur ended the read cycle
  assert.equal(guard.ensure(), true, 'the drift is repaired');
  assert.equal(box.focusCalls, 1);
  assert.equal(box.readCalls, 1);
  assert.equal(guard.repairs, 1);
  assert.equal(guard.ensure(), false, 'a repaired box is left alone');
  assert.equal(box.focusCalls, 1, 'and is not focused a second time');

  assert.equal(guard.start(), true);
  assert.equal(timer.timers.length, 1);
  assert.equal(timer.timers[0].ms, FOCUS_CHECK_INTERVAL_MS);
  assert.equal(timer.timers[0].unrefCalled, true, 'the watchdog never holds the process open');
  assert.equal(guard.start(), false, 'starting twice is a no-op');
  assert.equal(guard.isRunning(), true);

  box.screen.focused = null;
  box._reading = false;
  timer.tick();
  assert.equal(guard.repairs, 2, 'the periodic check repairs without being asked');

  assert.equal(guard.stop(), true);
  assert.equal(guard.isRunning(), false);
  timer.tick();
  assert.equal(guard.repairs, 2, 'a stopped guard does nothing');

  assert.equal(guard.close(), true);
  assert.equal(guard.isClosed, true);
  assert.equal(guard.start(), false, 'a closed guard never restarts');
  box.screen.focused = null;
  box._reading = false;
  assert.equal(guard.ensure(), false, 'and never arms again');
});

test('createFocusGuard() stands down while a modal owns the keys or nothing is armed', () => {
  const timer = fakeTimer();
  const box = fakeBox();
  let armed = false;
  const guard = createFocusGuard({ inputBox: box, hold: () => armed, timer });

  box.screen.focused = null;
  box._reading = false;
  assert.equal(guard.ensure(), false, 'nobody is waiting for an answer');
  assert.equal(guard.checks, 0, 'the stand-down is not even a check');
  assert.equal(box.focusCalls, 0);

  armed = true;
  box.screen.lockKeys = true;
  assert.equal(guard.ensure(), false, 'a modal owns the keyboard');
  assert.equal(guard.checks, 0);
  assert.equal(box.focusCalls, 0);

  box.screen.lockKeys = false;
  assert.equal(guard.ensure(), true, 'once the modal closes the box is armed again');
  assert.equal(guard.checks, 1);
  assert.equal(box.focusCalls, 1);
});

test('a click on the transcript leaves the input box focused and reading', async () => {
  await withTui(async (tui, { input }) => {
    const first = tui.question('> ');
    await flush();
    assert.equal(tui.screen.focused, tui.inputBox, 'the armed box owns the focus');

    input.write('a');
    await flush();
    assert.equal(tui.inputBox.getValue(), 'a');

    const cell = cellOf(tui.transcript, 3);
    await click(tui, cell.x, cell.y);

    assert.equal(tui.screen.focused, tui.inputBox, 'the click did not move the caret');
    assert.equal(tui.inputBox._reading, true, 'the read cycle survived the click');
    assert.equal(listenerCount(tui.inputBox), 1, 'and there is still exactly one listener');

    input.write('b');
    await flush();
    assert.equal(tui.inputBox.getValue(), 'ab', 'the keystroke still lands');

    tui.inputBox.emit('submit', tui.inputBox.getValue());
    assert.equal(await first, 'ab');
  });
});

test('clicking the input box focuses it and restarts its read cycle', async () => {
  await withTui(async (tui, { input }) => {
    const first = tui.question('> ');
    await flush();

    // Drift the focus the way a stray event would: the transcript takes the caret
    // and the textarea's blur handler ends the read cycle.
    tui.transcript.focus();
    await flush();
    assert.notEqual(tui.screen.focused, tui.inputBox);
    assert.equal(tui.inputBox._reading, false, 'the read cycle is dead');

    input.write('x');
    await flush();
    assert.equal(tui.inputBox.getValue(), '', 'so the keystroke is dropped');

    const cell = cellOf(tui.inputBox, 1);
    await click(tui, cell.x, cell.y);

    assert.equal(tui.screen.focused, tui.inputBox, 'the click puts the caret back');
    assert.equal(tui.inputBox._reading, true, 'and restarts the read');
    assert.equal(listenerCount(tui.inputBox), 1, 'exactly one listener, not two');

    input.write('y');
    await flush();
    assert.equal(tui.inputBox.getValue(), 'y', 'typing works again');

    // A second click on an already armed box changes nothing.
    await click(tui, cell.x, cell.y);
    assert.equal(listenerCount(tui.inputBox), 1, 'clicking twice still leaves one listener');
    input.write('z');
    await flush();
    assert.equal(tui.inputBox.getValue(), 'yz', 'and each keystroke lands exactly once');

    tui.inputBox.emit('submit', tui.inputBox.getValue());
    assert.equal(await first, 'yz');
  });
});

test('the periodic check repairs a lost focus within one interval', async () => {
  await withTui(async (tui, { input }) => {
    const first = tui.question('> ');
    await flush();
    const repairsBefore = tui.focusRepairs;

    tui.transcript.focus();
    await flush();
    assert.equal(tui.inputBox._reading, false);

    const elapsed = await waitFor(() => armed(tui));
    assert.ok(elapsed >= 0, 'the watchdog put the focus back without being asked');
    assert.ok(elapsed <= FOCUS_CHECK_INTERVAL_MS + 250, `repaired in ${elapsed}ms`);
    assert.equal(tui.inputBox._reading, true, 'the read cycle was restarted');
    assert.ok(tui.focusRepairs > repairsBefore, 'the repair was counted');
    assert.equal(listenerCount(tui.inputBox), 1, 'one listener, so no keystroke doubles');

    input.write('q');
    await flush();
    assert.equal(tui.inputBox.getValue(), 'q', 'typing works after the repair');

    tui.inputBox.emit('submit', tui.inputBox.getValue());
    assert.equal(await first, 'q');
  });
});

test('the guard stands down while the picker modal owns the keyboard', async () => {
  await withTui(async (tui) => {
    const first = tui.question('> ');
    await flush();
    const repairsBefore = tui.focusRepairs;

    tui.screen.lockKeys = true;
    tui.transcript.focus();
    await flush();
    assert.equal(tui.focusGuard.ensure(), false, 'a locked screen is left alone');
    assert.equal(tui.screen.focused, tui.transcript, 'the modal keeps the focus');
    assert.equal(tui.focusRepairs, repairsBefore, 'no repair was counted');

    tui.screen.lockKeys = false;
    assert.equal(tui.focusGuard.ensure(), true, 'after the modal the box is armed again');
    assert.equal(tui.screen.focused, tui.inputBox);
    assert.equal(tui.inputBox._reading, true);

    tui.inputBox.emit('submit', '');
    await first;
  });
});
