import { TASK_FILE, PLAN_FILE } from '../config/constants.js';

/**
 * The transcript announcement of a tracking update (`docs/interface/tracking-notice`).
 *
 * `update_task` rewrites `task.md` / `implementation_plan.md` silently: the tool result
 * goes back to the model, and the user — who watches the conversation, not the two files —
 * has no way to tell that a milestone just happened. This module turns one tool update into
 * the one or two `[Tracking]` lines printed instead, in the palette's own contrasting
 * colour (`app/theme.js`), so an item being completed or a plan moving is visible at a
 * glance.
 *
 * Pure: `formatTrackingUpdate()` builds the text and `createTrackingNotifier()` binds it to
 * a logger, so the wording is unit tested without a terminal. Presentation only — these
 * lines never reach the model context or a session file.
 */

/** Every announcement line starts with this, which is what colours it. */
export const TRACKING_NOTICE_PREFIX = '[Tracking]';

/** `3/7` done, or `0/0` for a checklist that has not been filled in yet. */
function ratio(progress) {
  const total = Number(progress?.total) || 0;
  const done = Number(progress?.done) || 0;
  return `${done}/${total}`;
}

/** Quote one piece of model text, flattened to a single line so a row cannot break. */
function quoted(text) {
  return JSON.stringify(String(text ?? '').replace(/\s+/g, ' ').trim());
}

/** The plural-aware noun of a count: `1 step`, `2 steps`. */
function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The lines one tracking update prints, in order: the checklist first (it is what the user
 * cares about), the plan second (it follows the checklist).
 *
 * @param {object} update what `update_task` reports about a write that happened
 * @returns {string[]} zero or more `[Tracking] …` lines
 */
export function formatTrackingUpdate(update = {}) {
  const lines = [];
  const action = update.action;

  if (action === 'complete' && update.completed) {
    lines.push(`${TRACKING_NOTICE_PREFIX} ${TASK_FILE} · ${quoted(update.completed)} done — ${ratio(update.progress)} items`
      + (update.next ? `, next: ${quoted(update.next)}` : ', checklist finished'));
  } else if (action === 'status') {
    lines.push(`${TRACKING_NOTICE_PREFIX} ${TASK_FILE} · status: ${String(update.status ?? '').trim() || 'pending'}`);
  } else if (action === 'start' && update.next) {
    lines.push(`${TRACKING_NOTICE_PREFIX} ${TASK_FILE} · working on ${quoted(update.next)} — ${ratio(update.progress)} items done`);
  }

  if (update.step) {
    lines.push(`${TRACKING_NOTICE_PREFIX} ${PLAN_FILE} · step ${quoted(update.step)} ticked — ${ratio(update.plan)} steps`);
  } else if (update.planTarget) {
    const steps = Number(update.planSteps) || 0;
    lines.push(`${TRACKING_NOTICE_PREFIX} ${PLAN_FILE} · reset for ${quoted(update.planTarget)}`
      + (steps > 0 ? ` — ${plural(steps, 'step')} queued` : ''));
  }

  return lines;
}

/**
 * Bind the announcement to a transcript logger. `notify(update)` prints the lines and
 * returns them, so the caller — and the tests — can see exactly what was shown.
 */
export function createTrackingNotifier({ log } = {}) {
  let announced = 0;

  return {
    notify(update) {
      const lines = formatTrackingUpdate(update);
      if (lines.length === 0) return [];
      if (typeof log === 'function') {
        for (const line of lines) log(line);
      }
      announced += 1;
      return lines;
    },
    /** How many updates have been announced so far. */
    get announced() {
      return announced;
    },
  };
}
