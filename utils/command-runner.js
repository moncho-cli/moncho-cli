import { spawn } from 'child_process';

/**
 * Run one command without ever blocking the event loop or the terminal.
 *
 * `execFileSync` is the reason a command could freeze the whole UI: the call does not
 * return until the child exits, so while a child waits for something — a `git`
 * credential prompt, an `ssh` password, a `read` — Node's event loop is stopped and no
 * key handler can run. Ctrl+C never reaches the abort manager, so the user cannot even
 * cancel. That is a hang, not a slow command, and the fix is structural rather than a
 * timeout: the child is spawned asynchronously and **never handed a terminal**.
 *
 * Three properties make the freeze impossible by construction:
 *
 *  - **stdin is `/dev/null`.** A child that tries to read gets end-of-file at once
 *    instead of waiting for a person. A credential prompt becomes an immediate failure
 *    with a reason, which is a result the model can act on.
 *  - **the environment forbids the prompt.** `GIT_TERMINAL_PROMPT=0`, an askpass that
 *    echoes, and `BatchMode=yes` for ssh mean the well-known offenders fail fast even
 *    when they would otherwise open `/dev/tty` directly rather than read stdin.
 *  - **the call is a promise.** The event loop stays free while the child runs, so key
 *    handling, repaints and cancellation all keep working; an `AbortSignal` kills the
 *    child instead of leaving it running.
 *
 * The runner never rejects: every outcome — success, non-zero exit, timeout, abort, a
 * binary that does not exist — resolves to the same result object, so a caller renders
 * one shape and cannot accidentally swallow a spawn failure.
 */

/** How much of each stream is kept before the child is stopped. */
export const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/** How long a child gets to exit after SIGTERM before it is killed outright. */
export const KILL_GRACE_MS = 2000;

/**
 * The environment a child runs with: the parent's, plus the variables that make the
 * interactive prompts fail fast. A command that needs a human is a command the harness
 * cannot run, so it must say so instead of waiting.
 */
export function childEnvironment(base = process.env) {
  return {
    ...base,
    // git: never prompt on the terminal; a credential helper that just echoes makes the
    // "ask the user" path fail immediately rather than hang.
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
    // ssh: no password prompt, no host-key question.
    SSH_ASKPASS: 'echo',
    SSH_ASKPASS_REQUIRE: 'never',
    // A pager would wait for keys forever; nothing here reads a screen.
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    // npm: no progress spinner, no interactive prompt.
    npm_config_yes: 'true',
    NPM_CONFIG_YES: 'true',
  };
}

/**
 * Run `argv` and resolve with its outcome. Never rejects.
 *
 * @param {string[]} argv the command and its arguments (no shell)
 * @param {object} [options]
 * @param {string} [options.cwd] working directory
 * @param {number} [options.timeoutMs] kill the child after this long
 * @param {AbortSignal|null} [options.signal] kill the child when aborted
 * @param {number} [options.maxBuffer] per-stream cap; the child is stopped when exceeded
 * @param {object} [options.env] the child's environment
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number|null, signal: string|null, timedOut: boolean, cancelled: boolean, overflow: boolean, spawnError: Error|null}>}
 */
export function runCommand(argv, {
  cwd = undefined,
  timeoutMs = 0,
  signal = null,
  maxBuffer = DEFAULT_MAX_BUFFER,
  env = childEnvironment(),
} = {}) {
  return new Promise((resolve) => {
    const result = {
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      overflow: false,
      spawnError: null,
    };

    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        // stdin is /dev/null: a child that reads gets EOF instead of a terminal. stdout
        // and stderr are pipes so the caller can window and capture them.
        stdio: ['ignore', 'pipe', 'pipe'],
        // A new process group would escape the abort; the child stays in ours.
        detached: false,
        windowsHide: true,
      });
    } catch (error) {
      result.spawnError = error;
      resolve(result);
      return;
    }

    let settled = false;
    let timer = null;
    let killTimer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      timer = null;
      killTimer = null;
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const settle = (patch = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ...result, ...patch });
    };

    /** Stop the child: SIGTERM, then SIGKILL once the grace period is over. */
    const stop = () => {
      if (settled) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // The child may already be gone; the exit handler still settles the promise.
      }
      if (!killTimer) {
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already reaped.
          }
        }, KILL_GRACE_MS);
        if (typeof killTimer.unref === 'function') killTimer.unref();
      }
    };

    function onAbort() {
      result.cancelled = true;
      stop();
    }

    if (signal) {
      if (signal.aborted) {
        result.cancelled = true;
        stop();
      } else if (typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    if (Number.isInteger(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        result.timedOut = true;
        stop();
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }

    const append = (stream, text) => {
      if (result[stream].length + text.length > maxBuffer) {
        result.overflow = true;
        result[stream] += text.slice(0, Math.max(0, maxBuffer - result[stream].length));
        stop();
        return;
      }
      result[stream] += text;
    };

    child.stdout?.on('data', (chunk) => append('stdout', String(chunk)));
    child.stderr?.on('data', (chunk) => append('stderr', String(chunk)));

    child.on('error', (error) => {
      result.spawnError = error;
      settle();
    });

    child.on('close', (code, closeSignal) => {
      settle({ exitCode: typeof code === 'number' ? code : null, signal: closeSignal ?? null });
    });
  });
}
