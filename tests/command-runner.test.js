import test from 'node:test';
import assert from 'node:assert/strict';

import { runCommand, childEnvironment, KILL_GRACE_MS } from '../utils/command-runner.js';
import { execute as runBashExecute } from '../tools/run_bash.js';

/**
 * The non-blocking command runner (`docs/agent/command-sandbox`).
 *
 * The bug this suite exists for: `run_bash` used `execFileSync`, which does not return
 * until the child exits, so a child that opened a terminal prompt — a `git` credential
 * ask, an `ssh` password — stopped Node's event loop dead. No key handler could run, so
 * Ctrl+C never reached the abort manager and the UI froze with no way out but killing
 * the process.
 *
 * Each case pins one of the three properties that make that impossible:
 *   1. the call is a promise, so the event loop keeps running while the child does;
 *   2. the child is given no terminal and an environment of fail-fast variables, so a
 *      prompt becomes an immediate result instead of a wait;
 *   3. an AbortSignal kills the child, so cancelling reaches the process.
 */

// A child that would wait forever if it could read a terminal: it resumes stdin and only
// exits on end-of-input, which a /dev/null stdin delivers at once.
const READ_STDIN = 'process.stdin.on("end", () => process.exit(7)); process.stdin.resume();';

// A child that outlives any sensible assertion: the one a cancel must kill.
const IDLE_FOREVER = 'setTimeout(() => {}, 60000);';

test('the runner is asynchronous so the event loop keeps turning while a child runs', async () => {
  const ticks = [];
  const interval = setInterval(() => ticks.push(1), 20);
  const result = await runCommand(['node', '-e', 'setTimeout(() => {}, 400)']);
  clearInterval(interval);

  assert.equal(result.exitCode, 0);
  // With a synchronous call this would be 0: the timer could not fire until the child
  // had already exited. Several ticks prove the loop was free the whole time.
  assert.ok(ticks.length >= 5, `expected the loop to keep ticking, got ${ticks.length}`);
});

test('the runner hands the child no terminal, so a prompt fails fast instead of hanging', async () => {
  const started = Date.now();
  const result = await runCommand(['node', '-e', READ_STDIN], { timeoutMs: 10000 });
  const elapsed = Date.now() - started;

  assert.equal(result.timedOut, false, 'it must not have waited for the timeout');
  assert.equal(result.exitCode, 7, 'stdin reached end-of-file at once');
  assert.ok(elapsed < 3000, `expected an immediate EOF, took ${elapsed}ms`);
});

test('the environment makes the interactive prompts fail fast', () => {
  const env = childEnvironment({ PATH: '/usr/bin' });
  assert.equal(env.PATH, '/usr/bin', 'the parent environment is kept');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0', 'git must not ask on the terminal');
  assert.ok(env.GIT_ASKPASS, 'git needs an askpass that cannot reach a person');
  assert.match(env.GIT_SSH_COMMAND, /BatchMode=yes/, 'ssh must not prompt for a password');
  assert.equal(env.SSH_ASKPASS_REQUIRE, 'never');
  assert.equal(env.PAGER, 'cat', 'a pager would wait for keys forever');
  assert.equal(env.npm_config_yes, 'true', 'npm must not ask');
});

test('an abort kills the child rather than merely stopping the wait', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 80);
  const started = Date.now();
  const result = await runCommand(['node', '-e', IDLE_FOREVER], { signal: controller.signal });
  clearTimeout(timer);
  const elapsed = Date.now() - started;

  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.ok(elapsed < 1000 + KILL_GRACE_MS, `the child was killed promptly, took ${elapsed}ms`);
});

test('an already-aborted signal never starts the child at all', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runCommand(['node', '-e', IDLE_FOREVER], { signal: controller.signal });
  assert.equal(result.cancelled, true);
});

test('a timeout stops the child and names the reason', async () => {
  const result = await runCommand(['node', '-e', IDLE_FOREVER], { timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
});

test('a binary that does not exist resolves a spawn error instead of rejecting', async () => {
  const result = await runCommand(['definitely-not-a-real-binary-xyz']);
  assert.ok(result.spawnError instanceof Error, 'the failure is reported, never thrown');
  assert.equal(result.exitCode, null);
});

test('a child over the buffer cap is stopped rather than grown without limit', async () => {
  const result = await runCommand(
    ['node', '-e', 'const b = Buffer.alloc(4096); for (let i = 0; i < 200; i++) process.stdout.write(b);'],
    { maxBuffer: 8192 },
  );
  assert.equal(result.overflow, true);
  assert.ok(result.stdout.length <= 8192);
});

test('run_bash answers CANCELLED when the task it belongs to is cancelled', async () => {
  const controller = new AbortController();
  const call = runBashExecute({ command: 'node -e "setTimeout(() => {}, 60000)"', intent: 'idle' }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 80);
  const parsed = JSON.parse(await call);

  assert.equal(parsed.status, 'error');
  assert.equal(parsed.code, 'CANCELLED');
});

test('run_bash runs a command to completion and reports its exit code as before', async () => {
  const doc = await runBashExecute({ command: 'echo hello', intent: 'say hello' });
  assert.match(doc, /^status: success/m);
  assert.match(doc, /\n---\nhello$/);
});
