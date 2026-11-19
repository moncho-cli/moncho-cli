import { PLAN_FILE } from '../config/constants.js';
import { readPlanContent, writePlanContent, trackingPaths } from './tracking-store.js';
import { notifyTrackingUpdate } from './host.js';
import {
  parsePlanSteps, findPlanStep, readStatusLine, planProgress,
} from './plan-file.js';
import {
  renderPlanFile, readTitle, extractNotes,
} from './tracking-format.js';

/**
 * `action: "step"` — tick exactly one verified plan step, and the refusal shape both
 * halves of the tracking loop answer with.
 *
 * This is the half of the loop that keeps the plan honest **while** an item is in
 * flight: `update_task` normally moves the checklist, but a step is ticked the moment it
 * is proven, so `implementation_plan.md` is a live record rather than a document written
 * once at the start of an item. The plan is the only file written here (the checklist is
 * untouched, so the reply carries `taskWritten: false`), and the moment the last step is
 * ticked the plan's own `status:` line records that the item is verified.
 *
 * Like every other write in the protocol, the document is **re-rendered** rather than
 * patched in place (`utils/tracking-format.js`), so the title and the human notes
 * survive and everything else is the canonical shape.
 *
 * A refusal is a structured value, never a thrown error, so a failed selection can never
 * touch a file — the caller turns it into the tool result unchanged.
 */

/** A structured refusal, so a failed selection never touches a file. */
export function refusal(code, message, extra = {}) {
  return JSON.stringify({ status: 'error', code, message, ...extra });
}

/** The plan progress of a list of `{ text, done }` entries. */
function progressOf(entries) {
  return {
    total: entries.length,
    done: entries.filter((entry) => entry.done).length,
    pending: entries.filter((entry) => !entry.done).length,
  };
}

/**
 * Tick one step of the current plan.
 *
 * @param {object} args the tool arguments (`step`/`stepIndex` select, `status` overrides)
 * @param {object} context the checklist state the reply echoes back
 * @param {string|null} context.taskStatus the checklist `status:` line
 * @param {object} context.progress the checklist `{ total, done, pending }`
 * @param {object} [context.paths] the resolved paths, echoed back to the model
 * @returns {Promise<string>} the JSON tool result
 */
export async function completeStep(args, { taskStatus = null, progress = null, paths = null } = {}) {
  const planContent = readPlanContent();
  if (planContent === null) {
    return refusal('PLAN_FILE_NOT_FOUND', `There is no ${PLAN_FILE} yet; start an item before ticking its steps.`);
  }

  const steps = parsePlanSteps(planContent);
  const selection = findPlanStep(steps, { index: args.stepIndex, query: args.step });
  if (selection.error) {
    return refusal('STEP_NOT_FOUND', selection.error, {
      steps: steps.map((step, i) => ({ index: i + 1, done: step.done, text: step.text }))
    });
  }

  const step = selection.item;
  if (step.done) {
    return JSON.stringify({
      status: 'skipped',
      code: 'ALREADY_DONE',
      message: `Plan step ${JSON.stringify(step.text)} is already ticked.`,
      planProgress: planProgress(planContent)
    });
  }

  const ticked = steps.map((entry) => ({
    text: entry.text,
    done: entry.line === step.line ? true : entry.done,
  }));
  const after = progressOf(ticked);
  const newStatus = typeof args.status === 'string' && args.status.trim() !== ''
    ? args.status.trim()
    : (after.pending === 0 ? 'done' : (readStatusLine(planContent) ?? 'in progress'));

  writePlanContent(renderPlanFile({
    title: readTitle(planContent) || undefined,
    status: newStatus,
    steps: ticked,
    notes: extractNotes(planContent),
  }));

  // A ticked step is a milestone too, so it is announced in the transcript like a
  // completed item (app/tracking-notice.js). Presentation only: not a chunk.
  const trackingLines = notifyTrackingUpdate({
    action: 'step',
    step: step.text,
    plan: after,
  });

  return JSON.stringify({
    status: 'success',
    action: 'step',
    taskFile: (paths ?? trackingPaths()).task,
    planFile: (paths ?? trackingPaths()).plan,
    step: step.text,
    planStatus: newStatus || null,
    taskStatus,
    planProgress: after,
    progress,
    taskWritten: false,
    planWritten: true,
    // The `[Tracking]` row the transcript showed for this tick (empty with no front end).
    trackingLines,
    message: after.pending === 0
      ? `Ticked the last plan step: ${step.text}. Every step of the current item is verified.`
      : `Ticked plan step: ${step.text}. ${after.pending} step(s) still pending.`
  });
}