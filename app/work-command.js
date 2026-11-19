import { TASK_FILE } from '../config/constants.js';
import { readFileIfExists } from '../utils/file-io.js';
import { parseCheckboxItems } from '../utils/plan-file.js';
import { getSession, getSessionTaskContent } from '../utils/host.js';

/**
 * `/work on` and `/work off`: the execution lock, reached from the command line.
 *
 * `app/session-mode.js` owns the state — `setWork(true)` pins the mode to `Work` and
 * engages the lock, `setWork(false)` releases it and falls back to `Design` — while
 * this command owns the two things the state itself cannot decide:
 *
 *  - **is there anything to work on?** `/work on` refuses a session with no `task.md`
 *    and one whose items are all done: a lock with nothing behind it would leave the
 *    session self-driving over an empty checklist.
 *  - **what does the user see?** it returns a plain result object; the host formats and
 *    logs it, so both front ends behave the same way (`docs/interface/commands`).
 *
 * The mode is read from `ctx.mode` (a `createSessionMode()`) rather than captured, so
 * the same registry drives the live session and a test, and `ctx.readTask` lets a test
 * supply the checklist instead of depending on the working tree.
 */

/**
 * Read the items of `task.md` from session or file.
 * @param {Function} [readFile] the file reader (defaults to the project one)
 * @returns {object[]|null} the checkbox items, or `null` when the file is missing
 */
export function readTaskItems(readFile = readFileIfExists) {
  // Try to get from session first
  const session = getSession();
  if (session) {
    const taskContent = getSessionTaskContent();
    if (taskContent !== null) {
      return parseCheckboxItems(taskContent);
    }
  }
  
  // Fall back to file
  const content = readFile(TASK_FILE);
  if (typeof content !== 'string') return null;
  return parseCheckboxItems(content);
}

/** The pending/total counts and the next item in line. */
function progress(items) {
  const pending = items.filter((item) => !item.done);
  return { pending: pending.length, total: items.length, next: pending[0] || null };
}

/** A refusal the user can act on: its own code, and a message naming the reason. */
function refuse(code, message) {
  return { ok: false, code, message };
}

/** The state a successful result reports back to the host. */
function stateOf(mode) {
  return mode.describe();
}

/** `/work` — turn the execution lock on or off. */
export function workCommand() {
  return {
    name: 'work',
    description: 'turn the execution lock on or off (/work on, /work off)',
    run(ctx = {}) {
      const { arg = '', mode = null, readTask = readFileIfExists } = ctx;
      const action = String(arg).trim().toLowerCase();

      if (!mode || typeof mode.setWork !== 'function' || typeof mode.describe !== 'function') {
        return refuse('NO_SESSION_MODE', 'This front end has no session mode, so the work lock cannot be moved.');
      }
      if (!action) {
        return {
          ok: true,
          code: 'WORK_STATE',
          state: stateOf(mode),
          message: `The session is in ${mode.describe().label}. Use /work on or /work off.`,
        };
      }
      if (action !== 'on' && action !== 'off') {
        return refuse('UNKNOWN_ARG', `Unknown argument "${arg}" for /work. Use /work on or /work off.`);
      }

      if (action === 'off') {
        const outcome = mode.setWork(false);
        return {
          ok: true,
          code: 'WORK_OFF',
          changed: outcome.changed,
          state: stateOf(mode),
          message: outcome.changed
            ? 'Work is off: the session stopped driving itself and fell back to Design.'
            : 'Work is already off.',
        };
      }

      // `/work on` needs a checklist to drive itself through.
      const items = readTaskItems(readTask);
      if (items === null) {
        return refuse('NO_TASK_FILE', `There is no ${TASK_FILE} to work through, so the lock stays off.`);
      }
      if (items.length === 0) {
        return refuse('NO_TASK_ITEMS', `${TASK_FILE} has no checkbox items, so the lock stays off.`);
      }
      const { pending, total, next } = progress(items);
      if (pending === 0) {
        return refuse(
          'ALL_ITEMS_DONE',
          `Every item in ${TASK_FILE} is done (${total}/${total}), so the lock stays off.`,
        );
      }

      const outcome = mode.setWork(true);
      if (outcome.changed === false) {
        return {
          ok: true,
          code: 'WORK_ON',
          changed: false,
          state: stateOf(mode),
          message: `Work is already on: ${pending} of ${total} item(s) still pending.`,
        };
      }
      return {
        ok: true,
        code: 'WORK_ON',
        changed: true,
        state: stateOf(mode),
        message: `Work is on: the session is locked to Work and drives itself. `
          + `${pending} of ${total} item(s) pending.`,
        lines: next ? [`Next: ${next.text}`] : [],
      };
    },
  };
}