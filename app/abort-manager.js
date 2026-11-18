import readline from 'readline';
import { isCtrlC, isInterruptKey } from '../utils/keys.js';

/**
 * Handles cancellation of the currently running task.
 *
 * ESC / Ctrl+C go through one entry point, interrupt(), whichever front end owns
 * stdin:
 *   - a task is running  -> the cancellation is confirmed first (see confirmMode);
 *     a further interrupt while the confirmation is armed cancels immediately, so
 *     ESC ESC / Ctrl+C Ctrl+C always stop the task;
 *   - no task is running -> the key is not an abort but an exit request, forwarded
 *     to onExit().
 *
 * Who delivers the keys:
 *   - line-based CLI: readline puts stdin in raw mode while a question is pending,
 *     so ^C never becomes a process-level SIGINT; readline re-emits it as an
 *     interface 'SIGINT' event (only while at least one listener is attached,
 *     otherwise readline closes the interface and rejects the question). Escape
 *     arrives as a plain stdin keypress.
 *   - process-level SIGINT is kept as a fallback for a non-raw stdin (e.g. the
 *     detached `start.sh start` run where readline is not in terminal mode).
 *   - TUI: neo-blessed owns stdin; `captureKeys: false` installs no stdin listener
 *     at all (a second 'keypress' listener on process.stdin would echo every typed
 *     character twice) and the screen's key listener calls interrupt() instead.
 *
 * confirmMode decides how the cancellation is confirmed:
 *   - 'prompt' (CLI): ask "Cancel this task? [y/N]" on the readline interface;
 *   - 'keys'   (TUI):  the TUI has a single shared input box, so a nested question
 *     would hijack the host loop's pending prompt; the first interrupt instead
 *     prints the instruction and the second one cancels.
 */
export class AbortManager {
  #rl;
  #log;
  #onExit;
  #confirmMode;
  #abortController = null;
  #isCancelled = false;
  #confirming = false;
  #exiting = false;
  #keypressHandler = null;
  #sigintHandler = null;
  #rlSigintHandler = null;

  constructor(rl, options = {}) {
    this.#rl = rl || null;
    this.#log = options.log || console.log;
    this.#onExit = typeof options.onExit === 'function' ? options.onExit : null;
    this.#confirmMode = options.confirmMode === 'keys' ? 'keys' : 'prompt';

    // readline reports ^C on the interface itself; keeping a listener also stops
    // readline from closing the interface on Ctrl+C.
    if (this.#rl && typeof this.#rl.on === 'function') {
      this.#rlSigintHandler = () => this.interrupt();
      this.#rl.on('SIGINT', this.#rlSigintHandler);
    }

    if (options.captureKeys !== false) {
      readline.emitKeypressEvents(process.stdin);
      this.#keypressHandler = (ch, key) => {
        if (!isInterruptKey(ch, key)) return;
        // Ctrl+C with readline attached is already reported as the interface's
        // SIGINT event; handling the raw byte too would fire interrupt() twice and
        // turn a confirmation into an immediate cancellation.
        if (this.#rlSigintHandler && isCtrlC(ch, key)) return;
        this.interrupt();
      };
      process.stdin.on('keypress', this.#keypressHandler);
    }

    this.#sigintHandler = () => this.interrupt();
    process.on('SIGINT', this.#sigintHandler);
  }

  /** Detach every listener this manager installed. */
  dispose() {
    if (this.#keypressHandler) {
      process.stdin.removeListener('keypress', this.#keypressHandler);
      this.#keypressHandler = null;
    }
    if (this.#rlSigintHandler && this.#rl) {
      this.#rl.removeListener('SIGINT', this.#rlSigintHandler);
      this.#rlSigintHandler = null;
    }
    if (this.#sigintHandler) {
      process.removeListener('SIGINT', this.#sigintHandler);
      this.#sigintHandler = null;
    }
  }

  get isCancelled() {
    return this.#isCancelled;
  }

  /** True while a task is in flight and has not been cancelled yet. */
  get hasActiveTask() {
    return Boolean(this.#abortController) && !this.#isCancelled;
  }

  get signal() {
    return this.#abortController?.signal ?? null;
  }

  /** Begin a cancellable task and return its AbortSignal. */
  startTask() {
    this.#abortController = new AbortController();
    this.#isCancelled = false;
    this.#confirming = false;
    return this.#abortController.signal;
  }

  /** Mark the current task as finished (also disarms a pending confirmation). */
  endTask() {
    this.#abortController = null;
    this.#confirming = false;
  }

  /** Abort the running task without asking (used after confirmation). */
  cancelActiveTask() {
    if (!this.#abortController || this.#isCancelled) return false;
    this.#isCancelled = true;
    this.#confirming = false;
    this.#abortController.abort();
    this.#log('\n[Info] Task cancelled by user.');
    return true;
  }

  /**
   * Confirm the cancellation of the running task. Safe to call repeatedly: while
   * the confirmation is armed a further interrupt cancels instead of asking again.
   */
  requestCancel() {
    if (!this.hasActiveTask || this.#confirming) return false;

    // In the line chat the readline interface is idle while a task runs, so a
    // y/N question is safe there; the TUI arms the key confirmation instead.
    if (this.#confirmMode === 'prompt' && typeof this.#rl?.question === 'function') {
      this.#confirming = true;
      this.#log('\n⚠️  A task is running.');
      this.#rl.question('Cancel this task? [y/N] ', (answer) => {
        this.#confirming = false;
        if (['y', 'yes'].includes(String(answer).trim().toLowerCase())) {
          this.cancelActiveTask();
        } else {
          this.#log('[Info] Continuing task.');
        }
      });
      return true;
    }

    this.#confirming = true;
    this.#log('\n⚠️  A task is running.');
    this.#log('[Info] Press ESC or Ctrl+C again to cancel it.');
    return true;
  }

  /** Ask the host to leave the application (only when no task is running). */
  requestExit() {
    if (!this.#onExit || this.#exiting) return false;
    this.#exiting = true;
    this.#onExit();
    return true;
  }

  /** Single entry point for ESC / Ctrl+C. */
  interrupt() {
    if (this.#exiting) return false;
    // A cancelled task is still unwinding through the host loop: further interrupt
    // keys must be ignored until endTask(), otherwise the second Ctrl+C of a double
    // press would be taken as an exit request.
    if (this.#abortController && this.#isCancelled) return false;
    if (this.#confirming) return this.cancelActiveTask();
    if (!this.hasActiveTask) return this.requestExit();
    return this.requestCancel();
  }
}
