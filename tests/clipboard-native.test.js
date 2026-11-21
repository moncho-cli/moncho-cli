import test from 'node:test';
import assert from 'node:assert/strict';

import { createNativeClipboard, nativeClipboardCandidates } from '../app/clipboard-native.js';
import { createClipboard } from '../app/clipboard.js';
import { clipboardText } from './support/clipboard-text.js';

/**
 * The native clipboard writer (docs/interface/clipboard-selection).
 *
 * This path exists because OSC 52 is honoured only when the terminal chooses to: a terminal
 * that does not implement it drops the sequence in silence, so the reader gets a
 * confirmation toast and an empty clipboard. A native tool that exits 0 is the one thing
 * that proves the text landed, so it is tried first and the sequence is the fallback.
 *
 * `spawnSync` is injected, so the order, the fall-through and the "a missing tool is
 * discovered once" rule are all proven with a recorder instead of a real clipboard.
 */

/** A recorder shaped like `spawnSync`, driven by a map of tool name -> result. */
function fakeSpawn(script) {
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args: Array.from(args) });
    const answer = script[command];
    if (answer === undefined) {
      return { error: Object.assign(new Error('not found'), { code: 'ENOENT' }) };
    }
    if (typeof answer === 'number') return { status: answer, error: null };
    return answer;
  };
  return { spawn, calls, commands: () => calls.map((call) => call.command) };
}

test('the clipboard tools are chosen from the platform and the session', () => {
  assert.deepEqual(
    nativeClipboardCandidates({ platform: 'darwin', env: {} }).map((c) => c.command),
    ['pbcopy'],
    'macOS has pbcopy and no use for the X11 tools',
  );
  assert.deepEqual(
    nativeClipboardCandidates({ platform: 'win32', env: {} }).map((c) => c.command),
    ['clip'],
    'Windows has clip.exe',
  );
  // A Wayland session tries wl-copy first: xclip exists under XWayland and would silently
  // target a display nobody is looking at.
  assert.deepEqual(
    nativeClipboardCandidates({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } })
      .map((c) => c.command),
    ['wl-copy', 'xclip', 'xsel'],
  );
  assert.deepEqual(
    nativeClipboardCandidates({ platform: 'linux', env: {} }).map((c) => c.command),
    ['xclip', 'xsel', 'wl-copy'],
    'an X11 session prefers xclip, and still falls back to wl-copy',
  );
  // xclip needs the selection named, or it targets the X primary selection by default.
  const xclip = nativeClipboardCandidates({ platform: 'linux', env: {} })[0];
  assert.deepEqual(xclip.args, ['-selection', 'clipboard']);
});

test('the first tool that accepts the text wins, and the rest are never spawned', () => {
  const { spawn, commands, calls } = fakeSpawn({ xclip: 0, xsel: 0, 'wl-copy': 0 });
  const clipboard = createNativeClipboard({ platform: 'linux', env: {}, spawn });

  const result = clipboard.write('alpha bravo');
  assert.deepEqual(result, { ok: true, via: 'xclip', error: null });
  assert.deepEqual(commands(), ['xclip'], 'the later tools were not tried');
  assert.equal(calls[0].args.join(' '), '-selection clipboard');
});

test('a tool that is not installed is skipped and remembered, so it is tried once', () => {
  // xclip is absent, xsel takes it. The second write must not spawn xclip again: on a box
  // without it, every copy would otherwise pay for the same failed process.
  const { spawn, commands } = fakeSpawn({ xsel: 0 });
  const clipboard = createNativeClipboard({ platform: 'linux', env: {}, spawn });

  assert.deepEqual(clipboard.write('one'), { ok: true, via: 'xsel', error: null });
  assert.ok(clipboard.missing().includes('xclip'), 'xclip is known to be missing');

  assert.deepEqual(clipboard.write('two'), { ok: true, via: 'xsel', error: null });
  assert.deepEqual(commands(), ['xclip', 'xsel', 'xsel'], 'xclip was not spawned a second time');
});

test('a tool that fails is passed over for the next, and none working is reported not thrown', () => {
  // xclip exists but exits non-zero (no X display), so the writer moves on.
  const { spawn } = fakeSpawn({ xclip: 1, xsel: 0 });
  const viaXsel = createNativeClipboard({ platform: 'linux', env: {}, spawn });
  assert.deepEqual(viaXsel.write('text'), { ok: true, via: 'xsel', error: null });

  // Nothing works at all: a reason, never an exception.
  const none = fakeSpawn({ xclip: 1, xsel: 2, 'wl-copy': 1 });
  const failing = createNativeClipboard({ platform: 'linux', env: {}, spawn: none.spawn });
  const result = failing.write('text');
  assert.equal(result.ok, false);
  assert.equal(result.via, null);
  assert.equal(result.error, 'EXIT_1', 'the last reason is the one reported');

  // A throwing spawn is contained the same way, and an empty text is not a copy.
  const throwing = createNativeClipboard({
    platform: 'linux',
    env: {},
    spawn: () => { throw Object.assign(new Error('EPIPE'), { code: 'EPIPE' }); },
  });
  assert.deepEqual(throwing.write('text'), { ok: false, via: null, error: 'EPIPE' });
  assert.deepEqual(throwing.write(''), { ok: false, via: null, error: 'EMPTY' });
});

test('createClipboard() prefers the native tool and falls back to the OSC 52 sequence', () => {
  const written = [];

  // A native tool that works: the sequence is never built, and the report says which path
  // delivered the text so a caller can say how it landed.
  const native = { write: () => ({ ok: true, via: 'pbcopy', error: null }) };
  const withNative = createClipboard({
    native, write: (sequence) => written.push(sequence), env: {},
  });
  const copied = withNative.copy('alpha');
  assert.deepEqual(
    { ok: copied.ok, via: copied.via, chars: copied.chars },
    { ok: true, via: 'pbcopy', chars: 5 },
  );
  assert.deepEqual(written, [], 'the escape sequence was not used when the tool worked');

  // The tool declines, so the sequence carries it — and the report still says so.
  const declining = createClipboard({
    native: { write: () => ({ ok: false, via: null, error: 'ENOENT' }) },
    write: (sequence) => written.push(sequence),
    env: {},
  });
  const fallback = declining.copy('alpha');
  assert.equal(fallback.ok, true);
  assert.equal(fallback.via, 'osc52');
  assert.equal(clipboardText(written[0]), 'alpha');

  // No tool and no writer is the honest failure, not a crash.
  const nowhere = createClipboard({ env: {} });
  assert.deepEqual(
    { ok: nowhere.copy('alpha').ok, error: nowhere.copy('alpha').error },
    { ok: false, error: 'NO_WRITER' },
  );
});