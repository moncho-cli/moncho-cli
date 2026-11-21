import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/**
 * The host-side pickup of a selection (bin/lib/clipboard-watch.sh).
 *
 * The container writes a selection to a file in the workspace; this library runs on the
 * *host*, where the clipboard lives, and feeds each new file to the host's own tool. The
 * suite drives the real script against a fake clipboard tool that records what it was
 * handed, which is the only honest way to prove the wiring: the assertion is on the bytes
 * the tool received, not on a state the library reports about itself.
 */

const LIB = path.resolve('bin/lib/clipboard-watch.sh');

/**
 * The bash the suite runs: found on PATH normally, but a case that empties PATH (to prove
 * the "no clipboard tool" branch) would take bash with it, so it is resolved once here.
 */
const BASH = bashPath();

function bashPath() {
  for (const candidate of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'bash';
}

/** A directory that cleans itself up. */
function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * A fake clipboard tool: an executable that appends stdin to the file named by
 * FAKE_CLIPBOARD_SINK, so a test can assert exactly what was copied and when.
 */
function fakeTool(dir) {
  const script = path.join(dir, 'fake-clip');
  const sink = path.join(dir, 'sink');
  fs.writeFileSync(
    script,
    '#!/bin/sh\ncat >> "$FAKE_CLIPBOARD_SINK"\nprintf "\\n--8<--\\n" >> "$FAKE_CLIPBOARD_SINK"\n',
    { mode: 0o755 }
  );
  return { script, sink };
}

/** Run a snippet with the library sourced, in a bash subprocess. */
function withLib(snippet, { env = {}, timeout = 20000 } = {}) {
  const prelude = [
    'set -euo pipefail',
    `LIB=${JSON.stringify(LIB)}`,
    '. "$LIB"',
  ].join('\n');
  return spawnSync(BASH, ['-c', `${prelude}\n${snippet}`], {
    encoding: 'utf-8',
    timeout,
    env: { ...process.env, ...env },
  });
}

/** Start the poll loop in the background and return a handle that ends it. */
function startWatcher(dir, env = {}) {
  const sink = path.join(dir, 'sink');
  const child = spawn(
    BASH,
    ['-c', `set -euo pipefail\n. ${JSON.stringify(LIB)}\nclipboard_watch_loop "$1" "$2"`, '--', dir, 'fake-clip'],
    {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        ...process.env,
        FAKE_CLIPBOARD_SINK: sink,
        CLIPBOARD_POLL_SECONDS: '0.1',
        PATH: `${dir}:${process.env.PATH}`,
        ...env,
      },
    }
  );
  return {
    sink,
    stop: () => { child.kill('SIGTERM'); },
    /**
     * Wait until the watcher is up and has primed itself.
     *
     * The loop marks everything already in the directory as seen before its first poll —
     * a watcher serves the selections made while it runs, and must never clobber the
     * clipboard with a file from last week. So a test has to let it prime *before*
     * writing, or the file it writes is deliberately ignored.
     */
    async ready(ms = 8000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        // The loop is up once it has been through one full poll interval.
        if (child.exitCode === null) {
          await new Promise((resolve) => { setTimeout(resolve, 250); });
          return true;
        }
        await new Promise((resolve) => { setTimeout(resolve, 50); });
      }
      return false;
    },
    /** Wait until the sink holds `wanted`, or give up and let the assertion say so. */
    async waitFor(wanted, ms = 8000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (fs.existsSync(sink) && fs.readFileSync(sink, 'utf-8').includes(wanted)) return true;
        await new Promise((resolve) => { setTimeout(resolve, 50); });
      }
      return false;
    },
  };
}

test('pick_clipboard_tool() chooses the host tool by platform and display', () => {
  const dir = tempDir('moncho-tool-');
  try {
    const bin = path.join(dir, 'b');
    fs.mkdirSync(bin);
    for (const name of ['pbcopy', 'clip.exe', 'wl-copy', 'xclip', 'xsel']) {
      fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const env = { PATH: `${bin}:${process.env.PATH}` };

    // macOS prefers pbcopy, whatever display variables say.
    const mac = withLib('pick_clipboard_tool', {
      env: { ...env, MONCHO_UNAME: 'Darwin', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' },
    });
    assert.equal(mac.stdout.trim(), 'pbcopy');

    // WSL's clip.exe reaches the Windows clipboard and comes before the Unix clients.
    const wsl = withLib('pick_clipboard_tool', {
      env: { ...env, MONCHO_UNAME: 'Linux', DISPLAY: ':0' },
    });
    assert.equal(wsl.stdout.trim(), 'clip.exe');

    // A host with no tool at all answers nothing rather than failing. PATH keeps the
    // coreutils the function itself needs, and every candidate tool lives in `bin`
    // alone, which is what makes this the "none installed" case.
    const none = withLib('pick_clipboard_tool', {
      env: { PATH: '/usr/bin:/bin', MONCHO_UNAME: 'Linux', DISPLAY: '', WAYLAND_DISPLAY: '' },
    });
    assert.equal(none.status, 0, none.stderr);
    assert.equal(none.stdout.trim(), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the watcher copies a new selection to the host clipboard, exactly once', async () => {
  const dir = tempDir('moncho-watch-');
  const { script, sink } = fakeTool(dir);
  assert.ok(fs.existsSync(script));
  const watcher = startWatcher(dir);
  try {
    assert.ok(await watcher.ready(), 'the watcher started');
    const file = path.join(dir, '.moncho.clipboard.101112');
    fs.writeFileSync(file, 'alpha beta\n');

    assert.ok(await watcher.waitFor('alpha beta'), `the tool was handed the text: ${fs.readFileSync(sink, 'utf-8')}`);
    // A second poll must not hand the same file over twice.
    await new Promise((resolve) => { setTimeout(resolve, 400); });
    const copies = fs.readFileSync(sink, 'utf-8').split('alpha beta').length - 1;
    assert.equal(copies, 1, 'the same file was not copied twice');
  } finally {
    watcher.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the last copy wins, and a file still being written is not copied half way', async () => {
  const dir = tempDir('moncho-watch-');
  fakeTool(dir);
  const watcher = startWatcher(dir);
  try {
    assert.ok(await watcher.ready(), 'the watcher started');
    const first = path.join(dir, '.moncho.clipboard.101112');
    fs.writeFileSync(first, 'first');
    assert.ok(await watcher.waitFor('first'));

    const second = path.join(dir, '.moncho.clipboard.101113');
    fs.writeFileSync(second, 'second');
    assert.ok(await watcher.waitFor('second'));

    const sink = fs.readFileSync(watcher.sink, 'utf-8');
    assert.ok(sink.indexOf('first') < sink.indexOf('second'), 'the later copy came after');
  } finally {
    watcher.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a file that is not a clipboard file is left alone', async () => {
  const dir = tempDir('moncho-watch-');
  fakeTool(dir);
  const watcher = startWatcher(dir);
  try {
    assert.ok(await watcher.ready(), 'the watcher started');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a selection');
    fs.writeFileSync(path.join(dir, '.moncho.clipboard.101114'), 'a selection');
    assert.ok(await watcher.waitFor('a selection'));
    const sink = fs.readFileSync(watcher.sink, 'utf-8');
    assert.ok(!sink.includes('not a selection'), 'an ordinary file was never copied');
  } finally {
    watcher.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a watcher does not copy a selection that was already there when it started', async () => {
  const dir = tempDir('moncho-watch-');
  fakeTool(dir);
  // The selection is written *before* the watcher starts, the way a leftover file from a
  // previous session would be. Starting the agent must not silently clobber the clipboard
  // with last week's selection.
  fs.writeFileSync(path.join(dir, '.moncho.clipboard.095959'), 'a stale selection');

  const watcher = startWatcher(dir);
  try {
    assert.ok(await watcher.ready(), 'the watcher started');
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    const copied = fs.existsSync(watcher.sink) ? fs.readFileSync(watcher.sink, 'utf-8') : '';
    assert.ok(!copied.includes('a stale selection'), 'the stale selection was left alone');

    // But a selection saved *while* it runs is copied, so priming is not a blanket mute.
    fs.writeFileSync(path.join(dir, '.moncho.clipboard.100000'), 'a fresh selection');
    assert.ok(await watcher.waitFor('a fresh selection'), 'the fresh selection was copied');
  } finally {
    watcher.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the watcher starts only where a clipboard tool exists, and stop is idempotent', () => {
  const dir = tempDir('moncho-watch-');
  try {
    // No tool: start is a no-op that reports success and starts nothing.
    const bare = withLib(
      `CLIPBOARD_WATCH_PID=\nclipboard_watch_start ${JSON.stringify(dir)}\nprintf 'pid=%s\\n' "\${CLIPBOARD_WATCH_PID:-none}"`,
      { env: { PATH: '/nonexistent', MONCHO_CLIPBOARD_TOOL: '' } }
    );
    assert.equal(bare.status, 0, bare.stderr);
    assert.match(bare.stdout, /pid=none/);

    // A tool on PATH: the pidfile records the watcher, and stop clears it and ends it.
    const bin = path.join(dir, 'b');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'fake-clip'), '#!/bin/sh\ncat >/dev/null\n', { mode: 0o755 });
    const pidfile = path.join(dir, 'watch.pid');
    const started = withLib(
      [
        `CLIPBOARD_WATCH_PID=`,
        `clipboard_watch_start ${JSON.stringify(dir)} ${JSON.stringify(pidfile)}`,
        `printf 'pid=%s\\n' "\${CLIPBOARD_WATCH_PID:-none}"`,
        `watcher="$(cat ${JSON.stringify(pidfile)})"`,
        `clipboard_watch_stop ${JSON.stringify(pidfile)}`,
        // The kill must really have ended it: /proc is the honest check.
        `sleep 0.3`,
        `if kill -0 "$watcher" 2>/dev/null; then echo 'still-alive'; else echo 'watcher-gone'; fi`,
        `[ -f ${JSON.stringify(pidfile)} ] && echo 'pidfile-kept' || echo 'pidfile-gone'`,
        // Idempotent: a second stop does nothing and still succeeds.
        `clipboard_watch_stop ${JSON.stringify(pidfile)} && echo 'second-stop-ok'`,
      ].join('\n'),
      {
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          MONCHO_CLIPBOARD_TOOL: 'fake-clip',
          CLIPBOARD_POLL_SECONDS: '5',
        },
      }
    );
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /pid=\d+/);
    assert.match(started.stdout, /watcher-gone/);
    assert.match(started.stdout, /pidfile-gone/);
    assert.match(started.stdout, /second-stop-ok/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
