import test from 'node:test';
import assert from 'node:assert/strict';

import { createPasteRegistry } from '../app/paste-registry.js';
import { formatCompactionNotice, createCompactionNotifier } from '../app/compaction-notice.js';
import { bindKeys } from '../app/tui-keys.js';

/**
 * The pieces `app/tui.js` delegates to (docs/interface/tui).
 *
 * They were extracted so the screen wiring stays readable, and each is pure
 * enough to be driven without a terminal:
 *  - the paste table owns the `[[paste:<id>]]` ids and restores the bytes,
 *  - the compaction notice is emitted once per event,
 *  - the key bindings take Escape/Ctrl+C on the program (before blessed can turn
 *    them into the textarea's own 'cancel') and the scrolling keys on the screen.
 */

/** A minimal screen stub recording what the bindings did. */
function stubScreen() {
  const programListeners = new Map();
  const screenListeners = new Map();
  const add = (map, type, handler) => {
    const list = map.get(type) || [];
    list.push(handler);
    map.set(type, list);
  };
  const remove = (map, type, handler) => {
    map.set(type, (map.get(type) || []).filter((entry) => entry !== handler));
  };

  return {
    lockKeys: false,
    program: {
      prependListener: (type, handler) => add(programListeners, type, handler),
      removeListener: (type, handler) => remove(programListeners, type, handler),
    },
    on: (type, handler) => add(screenListeners, type, handler),
    removeListener: (type, handler) => remove(screenListeners, type, handler),
    emitProgram: (type, ...args) => {
      for (const handler of programListeners.get(type) || []) handler(...args);
    },
    emitScreen: (type, ...args) => {
      for (const handler of screenListeners.get(type) || []) handler(...args);
    },
    programCount: (type) => (programListeners.get(type) || []).length,
    screenCount: (type) => (screenListeners.get(type) || []).length,
  };
}

test('createPasteRegistry() collapses a long paste and restores it byte-for-byte', () => {
  const pastes = createPasteRegistry();
  const original = 'a\nb\nc\nd\ne';

  const collapsed = pastes.collapse(original);
  assert.equal(collapsed.text, '[[paste:0]]');
  assert.equal(collapsed.collapsed, true, 'the caller is told something was collapsed');
  assert.equal(pastes.expand(collapsed.text), original, 'the bytes come back exactly');
  assert.deepEqual(pastes.all, [original]);

  // a short input is left alone: nothing to collapse, nothing recorded
  const short = pastes.collapse('a\nb');
  assert.equal(short.text, 'a\nb');
  assert.equal(short.collapsed, false);
  assert.equal(pastes.all.length, 1, 'a short paste does not grow the table');

  // a second long paste gets its own id and does not overwrite the first
  const second = pastes.collapse(original);
  assert.equal(second.text, '[[paste:1]]');
  assert.equal(pastes.expand('[[paste:0]] and [[paste:1]]'), `${original} and ${original}`);
  assert.equal(pastes.expand('[[paste:9]]'), '[[paste:9]]', 'an unknown id is left as-is');
});

test('formatCompactionNotice() describes the split, tokens only when known', () => {
  const full = formatCompactionNotice({ olderChunks: 3, keptChunks: 2, olderTokens: 900, afterTokens: 120 });
  assert.match(full, /3 older chunk\(s\) -> summary, kept 2 newest chunk\(s\)/);
  assert.match(full, /\(900 -> 120 tokens\)/);

  const bare = formatCompactionNotice({ olderChunks: 1, keptChunks: 1 });
  assert.match(bare, /1 older chunk\(s\)/);
  assert.doesNotMatch(bare, /tokens\)/, 'no token counts means no token suffix');

  assert.match(formatCompactionNotice(), /0 older chunk\(s\)/, 'junk stats do not throw');
});

test('createCompactionNotifier() announces each compaction exactly once', () => {
  const lines = [];
  const notifier = createCompactionNotifier({ log: (line) => lines.push(line) });

  assert.equal(notifier.notify({ compactions: 0 }), null, 'no compaction yet');
  assert.equal(lines.length, 0);

  // the first real event is announced
  const line = notifier.notify({ compactions: 1, lastCompaction: { olderChunks: 2, keptChunks: 1 } });
  assert.match(line, /2 older chunk\(s\)/);
  assert.equal(lines.length, 1);
  assert.equal(notifier.announced, 1);

  // the same history again stays silent
  notifier.notify({ compactions: 1, lastCompaction: { olderChunks: 2, keptChunks: 1 } });
  assert.equal(lines.length, 1, 'a repeated count is not re-announced');

  // a later event is announced in turn
  notifier.notify({ compactions: 2, lastCompaction: { olderChunks: 5, keptChunks: 3 } });
  assert.match(lines[1], /5 older chunk\(s\)/);
  assert.equal(notifier.announced, 2);

  // a shrinking count is not a new event
  notifier.notify({ compactions: 1 });
  assert.equal(lines.length, 2, 'a shrinking count is not re-announced');
  assert.equal(notifier.notify(undefined), null, 'junk stats are not a crash');
});

test('bindKeys() forwards interrupts from the program and scrolls from the screen', () => {
  const screen = stubScreen();
  const interrupts = [];
  const pages = [];
  let refreshes = 0;
  const transcript = {
    perc: null,
    setScrollPerc(perc) { transcript.perc = perc; },
  };

  const keys = bindKeys({
    screen,
    onInterrupt: () => interrupts.push('interrupt'),
    scrollPage: (direction) => pages.push(direction),
    transcript,
    refresh: () => { refreshes += 1; },
  });

  // Escape / Ctrl+C arrive on the program and lock key dispatch for that event
  screen.emitProgram('keypress', '\x1b', { name: 'escape', full: 'escape' });
  assert.deepEqual(interrupts, ['interrupt']);
  assert.equal(screen.lockKeys, true, 'the key dispatch is locked while the host reacts');

  // a non-interrupt key on the program is left alone
  screen.emitProgram('keypress', 'a', { name: 'a', full: 'a' });
  assert.equal(interrupts.length, 1);

  // scrolling keys: a whole page, one row short of the screenful
  screen.emitScreen('keypress', null, { name: 'pageup', full: 'pageup' });
  screen.emitScreen('keypress', null, { name: 'pagedown', full: 'pagedown' });
  screen.emitScreen('keypress', null, { name: 'S-up', full: 'S-up' });
  assert.deepEqual(pages, [-1, 1, -1]);

  // home / end move the transcript and repaint
  screen.emitScreen('keypress', null, { name: 'home', full: 'home' });
  assert.equal(transcript.perc, 0);
  screen.emitScreen('keypress', null, { name: 'end', full: 'end' });
  assert.equal(transcript.perc, 100);
  assert.ok(refreshes >= 2, 'home/end repaint the screen');

  // an unknown key is ignored, and a keypress with no key object is not a crash
  const before = pages.length;
  screen.emitScreen('keypress', 'a', { name: 'a', full: 'a' });
  screen.emitScreen('keypress', 'a', null);
  assert.equal(pages.length, before);

  // dispose() detaches both listeners
  keys.dispose();
  assert.equal(screen.programCount('keypress'), 0);
  assert.equal(screen.screenCount('keypress'), 0);
});

test('bindKeys() without a screen is a harmless no-op', () => {
  const keys = bindKeys();
  assert.doesNotThrow(() => keys.dispose());
});
