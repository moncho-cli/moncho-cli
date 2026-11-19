import { TASK_FILE } from '../config/constants.js';
import { readFileIfExists } from '../utils/file-io.js';
import { parseCheckboxItems } from '../utils/plan-file.js';

/**
 * The `work:on` self-drive: the next prompt comes from `task.md`, not the keyboard.
 *
 * `work:on` is a *lock*, not a second agent (`docs/interface/modes`): the session keeps
 * one conversation, one context window and one session file, and the only thing the
 * lock changes is **where the next prompt comes from**. The host loop already asks a
 * single question between turns (`app/message-queue.js#nextPrompt`), so the driver is
 * a different `ask`, never a different application.
 *
 * Two rules keep it honest:
 *
 *  - **the queue still wins.** `nextPrompt()` drains a typed message before it asks
 *    anyone, so a chat message typed mid-run steers the very next turn.
 *  - **it is bounded.** An item the model never finishes would otherwise hand the same
 *    prompt over forever, at full provider cost. After `maxAttempts` identical
 *    hand-outs the drive stands down and reports why, leaving the lock on and the
 *    keyboard in charge: the user decides whether to retry or to `/work off`.
 */

/** How many times one unchanged item is handed to the model before the drive stops. */
export const WORK_DRIVE_MAX_ATTEMPTS = 2;

/**
 * The prompt for one item.
 *
 * It names the item verbatim and restates the tracking loop, because the model has to
 * *finish* the item — plan the steps, verify, then mark it done — for the drive to
 * move on.
 */
export function formatWorkPrompt(item) {
  const text = String(item?.text ?? '').trim() || 'the next pending item';
  return `Work through this item of ${TASK_FILE}: ${text}\n\n`
    + 'Plan the steps in implementation_plan.md, verify each one, then mark the item done '
    + 'with update_task so the session can move to the next item.';
}

/** The first item of `task.md` that is not done yet, or `null`. */
export function nextPendingItem(items = []) {
  return items.find((item) => !item.done) || null;
}

/**
 * Read the checklist. Returns `null` when `task.md` is missing, so a missing file is
 * told apart from an empty one.
 */
export function readChecklist(readFile = readFileIfExists) {
  const content = readFile(TASK_FILE);
  if (typeof content !== 'string') return null;
  return parseCheckboxItems(content);
}

/**
 * Build the driver.
 *
 * @param {object} options
 * @param {object} options.mode a `createSessionMode()`; the drive only runs while
 *   `mode.work` is true, read live on every call
 * @param {Function} [options.readTask] the reader (injectable for tests)
 * @param {Function} [options.log] the host logger, so the hand-out is on screen
 * @param {number} [options.maxAttempts] the identical-hand-out bound
 * @returns {{next: Function, reset: Function, describe: Function}}
 */
export function createWorkDrive({
  mode = null,
  readTask = readFileIfExists,
  log = () => {},
  maxAttempts = WORK_DRIVE_MAX_ATTEMPTS,
} = {}) {
  const limit = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : WORK_DRIVE_MAX_ATTEMPTS;
  let lastText = null;
  let repeats = 0;
  let stopped = null;

  const reset = () => {
    lastText = null;
    repeats = 0;
    stopped = null;
  };

  return {
    reset,

    /** Why the drive is not handing out prompts, when it stopped on purpose. */
    describe() {
      return { stopped, lastText, repeats, limit };
    },

    /**
     * The next prompt to run, or `null` when the drive is not in charge right now
     * (the lock is off, the checklist is finished, or it stood down) — in which case
     * the host falls back to the front end's own question.
     *
     * @returns {{prompt: string, item: object, attempt: number}|null}
     */
    next() {
      if (!mode?.work || stopped) return null;

      const items = readChecklist(readTask);
      if (items === null) return null;

      const item = nextPendingItem(items);
      if (!item) {
        // Nothing left: the drive is done, but the lock stays engaged — releasing it is
        // `/work off`'s job, never a side effect of finishing the list.
        stopped = 'done';
        return null;
      }

      if (item.text !== lastText) {
        lastText = item.text;
        repeats = 0;
      }
      repeats += 1;

      if (repeats > limit) {
        stopped = 'stalled';
        log(`[Work] The same item is still pending after ${limit} attempt(s): `
          + `"${item.text}". The drive stopped; type a direction or /work off.`);
        return null;
      }

      const prompt = formatWorkPrompt(item);
      log(`[Work] ${items.filter((entry) => !entry.done).length} item(s) pending · next: ${item.text}`);
      return { prompt, item, attempt: repeats };
    },
  };
}