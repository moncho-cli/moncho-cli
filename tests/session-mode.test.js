import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MODE_ORDER,
  MODES,
  DEFAULT_MODE,
  MODE_COLORS,
  WORK_LOCK_NOTICE,
  WORK_ON_LABEL,
  normalizeMode,
  nextMode,
  prevMode,
  modeStateKey,
  formatModeLabel,
  modeColor,
  createSessionMode,
} from '../app/session-mode.js';

/**
 * The intent-mode state machine: the mode the session is *for* is kept apart from
 * the `work:on` execution lock, and both front ends (Tab in the TUI, /work in the
 * registry) drive this same pure object.
 */

test('normalizeMode() falls back to chat for anything but the three known names', () => {
  assert.equal(normalizeMode('chat'), 'chat');
  assert.equal(normalizeMode('design'), 'design');
  assert.equal(normalizeMode('work'), 'work');
  // case and whitespace are forgiven; anything else is the safe, read-only default
  assert.equal(normalizeMode('  Work '), 'work');
  assert.equal(normalizeMode('DESIGN'), 'design');
  assert.equal(normalizeMode('banana'), 'chat');
  assert.equal(normalizeMode(''), 'chat');
  assert.equal(normalizeMode(null), 'chat');
  assert.equal(normalizeMode(undefined), 'chat');
});

test('nextMode() walks chat -> design -> work -> chat and wraps', () => {
  assert.deepEqual(MODE_ORDER, ['chat', 'design', 'work']);
  assert.equal(nextMode('chat'), 'design');
  assert.equal(nextMode('design'), 'work');
  assert.equal(nextMode('work'), 'chat');
  // an unknown mode enters the cycle at its start
  assert.equal(nextMode('nonsense'), 'design');
});

test('Tab cycles the three intent modes and announces every change once', () => {
  // the default is `work`, so the cycle is asserted from an explicit `chat`
  const mode = createSessionMode({ mode: 'chat' });
  const seen = [];
  const unsubscribe = mode.subscribe((state) => seen.push(state.key));

  assert.equal(mode.mode, 'chat', 'a session starts read-only');
  assert.equal(mode.cycle().changed, true);
  assert.equal(mode.mode, 'design');
  mode.cycle();
  assert.equal(mode.mode, 'work');
  mode.cycle();
  assert.equal(mode.mode, 'chat', 'work wraps back to chat');

  assert.deepEqual(seen, ['design', 'work', 'chat']);

  unsubscribe();
  mode.cycle();
  assert.equal(seen.length, 3, 'an unsubscribed listener hears nothing more');

  // a listener that throws never costs the user their mode change
  mode.subscribe(() => { throw new Error('broken repaint'); });
  assert.equal(mode.cycle().changed, true);
  assert.equal(mode.mode, 'work');
});

test('the work lock refuses Tab and any mode change, and explains itself', () => {
  const mode = createSessionMode({ mode: 'design' });
  mode.setWork(true);

  const cycled = mode.cycle();
  assert.equal(cycled.changed, false);
  assert.equal(cycled.reason, 'work-on');
  assert.equal(cycled.notice, WORK_LOCK_NOTICE);
  assert.equal(mode.mode, 'work', 'the refusal leaves the mode pinned');

  const switched = mode.setMode('chat');
  assert.equal(switched.changed, false);
  assert.equal(switched.reason, 'work-on');
  assert.match(switched.notice, /\/work off/);
  assert.equal(mode.mode, 'work');

  // setting the mode it is already in is a no-op even while locked
  const again = mode.setWork(true);
  assert.equal(again.changed, false);
  assert.equal(again.reason, 'already-on');
});

test('setWork(true) pins the mode to work, setWork(false) falls back to design', () => {
  const mode = createSessionMode({ mode: 'chat' });
  const seen = [];
  mode.subscribe((state) => seen.push(state.key));

  const on = mode.setWork(true);
  assert.equal(on.changed, true);
  assert.equal(mode.mode, 'work');
  assert.equal(mode.work, true);

  const off = mode.setWork(false);
  assert.equal(off.changed, true);
  assert.equal(mode.mode, 'design', 'releasing the lock never drops to chat');
  assert.equal(mode.work, false);
  assert.deepEqual(seen, ['work:on', 'design']);

  // releasing a lock that is off is a no-op
  assert.equal(mode.setWork(false).reason, 'already-off');
});

test('the state key, the label and one bright colour per state', () => {
  assert.equal(modeStateKey('chat', false), 'chat');
  assert.equal(modeStateKey('work', false), 'work');
  assert.equal(modeStateKey('work', true), 'work:on', 'the lock has its own state key');
  assert.equal(modeStateKey('chat', true), 'chat', 'the lock only renames the work mode');

  assert.equal(formatModeLabel('chat'), 'Chat');
  assert.equal(formatModeLabel('design'), 'Design');
  assert.equal(formatModeLabel('work'), 'Work');
  assert.equal(formatModeLabel('work', true), WORK_ON_LABEL);

  const colors = ['chat', 'design', 'work', 'work:on'].map((key) => modeColor(key === 'work:on' ? 'work' : key, key === 'work:on'));
  assert.equal(new Set(colors).size, 4, 'one colour per state, never shared');
  for (const color of colors) {
    assert.match(color, /green|cyan|yellow|red/, `${color} is a bright, readable colour`);
  }
  assert.equal(modeColor('work', true), MODE_COLORS['work:on']);
});

test('toJSON() round-trips the mode and the lock into createSessionMode()', () => {
  // a fresh session stores the mode it opens in, so /sessions restores `work`
  assert.deepEqual(createSessionMode().toJSON(), { mode: 'work', work: false });
  const mode = createSessionMode();
  mode.setMode('design');
  assert.deepEqual(mode.toJSON(), { mode: 'design', work: false });

  mode.setWork(true);
  const saved = mode.toJSON();
  assert.deepEqual(saved, { mode: 'work', work: true });

  const restored = createSessionMode(saved);
  assert.equal(restored.mode, 'work');
  assert.equal(restored.work, true);
  assert.equal(restored.describe().key, 'work:on');
  assert.equal(restored.describe().label, WORK_ON_LABEL);

  // a lock restored without an explicit mode still lands in work
  assert.equal(createSessionMode({ work: true }).mode, 'work');
  assert.equal(MODES.CHAT, 'chat');
  assert.equal(createSessionMode({ mode: 'junk' }).mode, 'chat');
});

test('a fresh session opens in work, while a junk stored mode stays in chat', () => {
  const fresh = createSessionMode();
  assert.equal(DEFAULT_MODE, 'work');
  assert.equal(fresh.mode, 'work', 'the default is the executing mode');
  assert.equal(fresh.work, false, 'opening in work is not the lock');
  assert.equal(fresh.describe().key, 'work');
  assert.equal(fresh.describe().label, 'Work');

  // what the session cannot vouch for stays read-only: a junk stored mode, an
  // empty string and a missing one are all the safe fallback, never `work`
  assert.equal(createSessionMode({ mode: 'junk' }).mode, 'chat');
  assert.equal(createSessionMode({ mode: '' }).mode, 'chat');
  assert.equal(createSessionMode({ mode: null }).mode, 'chat');

  // an explicit mode is always honoured, chat included
  assert.equal(createSessionMode({ mode: 'chat' }).mode, 'chat');
  assert.equal(createSessionMode({ mode: 'design' }).mode, 'design');
});

test('prevMode() walks the ring backwards and is the exact inverse of nextMode()', () => {
  assert.equal(prevMode('chat'), 'work');
  assert.equal(prevMode('work'), 'design');
  assert.equal(prevMode('design'), 'chat');
  // a junk mode enters the backward cycle at its end, not its start
  assert.equal(prevMode('nonsense'), 'work');

  for (const mode of MODE_ORDER) {
    assert.equal(prevMode(nextMode(mode)), mode, `${mode} round-trips`);
  }
});

test('restore() adopts the state of a resumed session instead of requesting a change', () => {
  // A locked session: `setMode()` is refused here, so resuming must restore, not ask.
  const mode = createSessionMode({ mode: MODES.WORK, work: true });

  const seen = [];
  mode.subscribe((state) => seen.push(state.key));

  const restored = mode.restore({ mode: MODES.DESIGN, work: false });
  assert.equal(mode.mode, MODES.DESIGN);
  assert.equal(mode.work, false, 'the lock came down with the stored state');
  assert.equal(restored.key, 'design');
  assert.deepEqual(seen, ['design'], 'the repaint is announced once');

  // A stored `work:on` is restored as `work:on`, never as a plain `Work`.
  mode.restore({ mode: 'chat', work: true });
  assert.equal(mode.describe().key, 'work:on', 'the lock wins over the stored mode name');

  // Junk lands in chat (the safe fallback) and a missing payload changes nothing.
  mode.restore({ mode: 'junk', work: false });
  assert.equal(mode.mode, MODES.CHAT);
  const before = mode.describe();
  assert.deepEqual(mode.restore(null), before, 'an old file restores nothing');
  assert.deepEqual(mode.toJSON(), { mode: 'chat', work: false });
});
