import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionMode, WORK_LOCK_NOTICE } from '../app/session-mode.js';
import { createModeController, MODE_REFUSAL_KIND } from '../app/mode-controller.js';
import { createTui } from '../app/tui.js';
import { fakeTty } from './support/tui-harness.js';

/**
 * The refusal route of the `Tab` binding.
 *
 * `app/tui-keys.js` only reports a direction; `app/mode-controller.js` calls
 * `sessionMode.cycle()` and, when the `work:on` lock refuses the move, hands the
 * machine's own `WORK_LOCK_NOTICE` to a sink. The rule under test is where that
 * refusal *goes*: the transient notice bar (or one plain line in the line CLI) —
 * never the transcript, which is the permanent record of the conversation.
 *
 * The pure routing is asserted without a terminal; one case drives a real TUI so the
 * notice and the untouched transcript are both read off the widget the user has.
 */

/** The visible text of a row, with the blessed colour escapes stripped. */
const strip = (content) => String(content ?? '').replace(/\x1b\[[\d;]*m/g, '');

/** A TUI with a live session mode; `fn(tui, controller, notices)` drives it. */
async function withModeTui(mode, fn) {
  const input = fakeTty();
  const output = fakeTty();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk.toString()));

  const notices = [];
  // The hook is installed before the notice bar exists (exactly like main.js), so the
  // binding is late-bound to a controller built from the surface it lives on.
  let controller = null;
  const tui = createTui({
    input,
    output,
    modelLabel: 'probe · model',
    mode,
    onCycleMode: (options) => controller?.cycle(options),
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller = createModeController({
    mode,
    notify: (kind, text) => { notices.push({ kind, text }); tui.notice(kind, text); },
  });
  try {
    return await fn(tui, controller, notices);
  } finally {
    if (tui) tui.close();
    input.destroy();
    output.destroy();
  }
}

test('a refused Tab under the work lock announces the notice and changes nothing', () => {
  const mode = createSessionMode({ work: true });
  const seen = [];
  const controller = createModeController({
    mode,
    notify: (kind, text) => seen.push({ kind, text }),
  });

  const before = mode.describe();
  const outcome = controller.cycle({ direction: 1 });

  assert.equal(outcome.changed, false, 'the locked session did not move');
  assert.equal(outcome.reason, 'work-on');
  assert.deepEqual(seen, [{ kind: MODE_REFUSAL_KIND, text: WORK_LOCK_NOTICE }]);
  assert.equal(controller.describe().key, before.key, 'the state is exactly as it was');
});

test('an accepted Tab is silent, so a real mode change raises no notice', () => {
  const mode = createSessionMode({ mode: 'chat' });
  const seen = [];
  const controller = createModeController({ mode, notify: (kind, text) => seen.push({ kind, text }) });

  assert.equal(controller.cycle({ direction: 1 }).changed, true);
  assert.equal(mode.mode, 'design');
  assert.equal(controller.cycle({ direction: -1 }).changed, true);
  assert.equal(mode.mode, 'chat', 'Shift+Tab walks the ring back');

  assert.deepEqual(seen, [], 'only a refusal speaks');
  assert.equal(controller.describe().label, 'Chat');
});

test('the controller survives a missing mode, a missing sink and a throwing sink', () => {
  // no mode at all: a keystroke must never crash the host
  const bare = createModeController();
  assert.equal(bare.cycle({ direction: 1 }), null);
  assert.equal(bare.describe(), null);

  // a locked mode with no sink: the refusal is answered, not thrown
  const locked = createSessionMode({ work: true });
  const silent = createModeController({ mode: locked });
  assert.equal(silent.cycle({ direction: -1 }).changed, false);
  assert.equal(locked.mode, 'work');

  // a sink that throws must not cost the user the keystroke either
  const noisy = createModeController({
    mode: locked,
    notify: () => { throw new Error('the notice bar is broken'); },
  });
  assert.doesNotThrow(() => noisy.cycle({}));
});

test('Tab against a locked session shows the refusal in the notice bar, never the transcript', async () => {
  const mode = createSessionMode({ work: true });

  await withModeTui(mode, async (tui, _controller, notices) => {
    tui.screen.program.emit('keypress', '\x09', { name: 'tab', full: 'tab' });
    await new Promise((resolve) => setImmediate(resolve));

    // the refusal really reached the floating box the user reads
    assert.equal(notices.length, 1);
    assert.match(strip(tui.noticeRows().join('\n')), /locked until \/work off/);
    // ... and the permanent record of the conversation is untouched
    assert.doesNotMatch(strip(tui.transcript.getContent()), /locked/);
    assert.equal(mode.work, true, 'Tab cannot leave the lock');
    assert.equal(tui.modeState.key, 'work:on');
  });
});
