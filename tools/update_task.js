import {
  TASK_FILE,
  PLAN_FILE
} from '../config/constants.js';
import { readFileIfExists, writeFileVerified } from '../utils/file-io.js';
import { defineTool } from '../utils/tool-schema.js';
import {
  parseCheckboxItems,
  findCheckboxItem,
  markCheckboxItem,
  readStatusLine,
  replaceStatusLine,
  parsePlanSteps,
  findPlanStep,
  markPlanStepDone,
  planProgress,
  renderPlan
} from '../utils/plan-file.js';

/**
 * `update_task` implements the task.md protocol in one place:
 *
 *   1. read the item list (checkbox lines like `- [ ] ...` / `- [x] ...`),
 *   2. mark exactly one item done (or advance the "status:" line),
 *   3. print the next item in line,
 *   4. reset implementation_plan.md with the steps for that next item, and
 *   5. tick one plan *step* as soon as it is verified (`step`).
 *
 * It is intentionally deterministic: the model supplies the plan text, the tool
 * does the file bookkeeping with verified atomic writes and refuses ambiguous
 * matches (0 or >1 items).
 *
 * The checkbox machinery (parsing, strict selection, the in-place tick, the plan
 * rendering) lives in utils/plan-file.js, so the step-level editing — the part
 * that makes the plan move while an item is still in flight — is pure and unit
 * tested on plain text. `renderPlan` stays exported from here for callers that
 * only know this tool.
 */

/** The items of task.md: its checkbox lines. */
export function parseTaskItems(content) {
  return parseCheckboxItems(content);
}

/** Read the `status:` line, if present. */
export function readTaskStatus(content) {
  return readStatusLine(content);
}

/**
 * Find the checkbox item matching `query` (by 1-based item index or substring).
 * @returns {{item: object|null, error: string|null, code: string|null}}
 */
export function findTaskItem(items, { index, query }) {
  return findCheckboxItem(items, { index, query, label: 'task item', queryParam: 'item', code: 'ITEM_NOT_FOUND' });
}

/** Mark the given item line as done (or undone), preserving indentation and marker. */
export function markItemDone(content, item, done = true) {
  return markCheckboxItem(content, item, done, { label: 'checkbox item' });
}

/** Next not-done item after the given one (by line order). */
export function nextPendingItem(items, afterItem) {
  const candidates = afterItem
    ? items.filter((item) => item.line > afterItem.line && !item.done)
    : items.filter((item) => !item.done);
  return candidates[0] || null;
}

/** A structured refusal, so a failed selection never touches a file. */
function refusal(code, message, extra = {}) {
  return JSON.stringify({ status: 'error', code, message, ...extra });
}

const { definition, execute } = defineTool({
  name: 'update_task',
  description:
    `Mark one item in ${TASK_FILE} as done (or update its "status:" line), tick one verified step of ${PLAN_FILE}, report the next pending item, and rewrite ${PLAN_FILE} with the steps for that item. This is the task-tracking loop required by task.md.`,
  parameters: {
    properties: {
      action: {
        type: 'string',
        enum: ['complete', 'start', 'step', 'status', 'list'],
        description:
          'complete = mark an item done and start the next one; start = reset the plan for an item; step = tick one verified step of the current plan; status = only update the status line; list = report progress without editing.'
      },
      item: {
        type: 'string',
        description: 'Substring of the task text to act on (must match exactly one item).'
      },
      index: {
        type: 'integer',
        description: '1-based index of the checkbox item to act on (alternative to "item").'
      },
      step: {
        type: 'string',
        description: `Substring of a step in ${PLAN_FILE} to tick with action "step" (must match exactly one step).`
      },
      stepIndex: {
        type: 'integer',
        description: `1-based index of the step in ${PLAN_FILE} to tick with action "step" (alternative to "step").`
      },
      status: {
        type: 'string',
        description: 'New value for the "status:" line, e.g. "in progress" or "done".'
      },
      steps: {
        type: 'array',
        items: { type: 'string' },
        description: `Steps to write into ${PLAN_FILE} for the current/next item.`
      },
      notes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional extra notes appended to the plan.'
      }
    },
    required: ['action']
  },
  async execute(args) {
    const action = args.action;
    if (!['complete', 'start', 'step', 'status', 'list'].includes(action)) {
      return refusal('INVALID_ACTION', `Unknown action ${JSON.stringify(action)}. Use complete, start, step, status or list.`);
    }

    const taskContent = readFileIfExists(TASK_FILE);
    if (taskContent === null) {
      return refusal('TASK_FILE_NOT_FOUND', `${TASK_FILE} does not exist.`);
    }

    const items = parseTaskItems(taskContent);
    const currentStatus = readTaskStatus(taskContent);
    const progress = {
      total: items.length,
      done: items.filter((item) => item.done).length,
      pending: items.filter((item) => !item.done).length
    };

    if (action === 'list') {
      const planContent = readFileIfExists(PLAN_FILE);
      return JSON.stringify({
        status: 'ok',
        action,
        taskFile: TASK_FILE,
        planFile: PLAN_FILE,
        taskStatus: currentStatus,
        progress,
        planProgress: planContent === null ? null : planProgress(planContent),
        items: items.map((item, i) => ({ index: i + 1, done: item.done, text: item.text })),
        next: nextPendingItem(items)?.text || null
      });
    }

    if (action === 'step') return await completeStep(args, taskContent, currentStatus, progress);

    const selection = action === 'status' ? { item: null, error: null } : findTaskItem(items, { index: args.index, query: args.item });
    if (selection.error) {
      return refusal('ITEM_NOT_FOUND', selection.error, {
        items: items.map((item, i) => ({ index: i + 1, done: item.done, text: item.text }))
      });
    }

    let updatedTask = taskContent;
    let completed = null;
    let nextItem = null;

    if (action === 'complete') {
      completed = selection.item;
      if (completed.done) {
        return JSON.stringify({ status: 'skipped', code: 'ALREADY_DONE', message: `Item ${JSON.stringify(completed.text)} is already marked done.`, progress });
      }
      updatedTask = markItemDone(updatedTask, completed, true);
      nextItem = nextPendingItem(parseTaskItems(updatedTask), { ...completed, done: true });
    } else {
      nextItem = selection.item || nextPendingItem(items);
    }

    const newStatus = action === 'complete'
      ? (nextItem ? `in progress: ${nextItem.text}` : 'done')
      : (typeof args.status === 'string' && args.status.trim() !== '' ? args.status.trim() : currentStatus);

    updatedTask = replaceStatusLine(updatedTask, newStatus);

    const taskWrite = updatedTask === taskContent ? null : writeFileVerified(TASK_FILE, updatedTask);
    const planTarget = nextItem || completed;
    const planWrite = writeFileVerified(PLAN_FILE, renderPlan({
      item: planTarget,
      status: newStatus || 'in progress',
      steps: Array.isArray(args.steps) ? args.steps : [],
      notes: Array.isArray(args.notes) ? args.notes : []
    }));

    return JSON.stringify({
      status: 'success',
      action,
      taskFile: TASK_FILE,
      planFile: PLAN_FILE,
      completed: completed ? completed.text : null,
      next: nextItem ? nextItem.text : null,
      taskStatus: newStatus || currentStatus,
      progress: {
        total: items.length,
        done: items.filter((item) => item.done).length + (completed ? 1 : 0),
        pending: items.filter((item) => !item.done).length - (completed ? 1 : 0)
      },
      taskWritten: Boolean(taskWrite),
      planWritten: Boolean(planWrite),
      message: completed
        ? `Marked done: ${completed.text}. Next: ${nextItem ? nextItem.text : 'none'}.`
        : `Plan reset for: ${planTarget ? planTarget.text : 'harness work'}.`
    });
  }
});

/**
 * `action: "step"` — tick exactly one verified step of the current plan.
 *
 * This is what makes the plan honest *while* an item is in flight: the plan file
 * is the only thing written, the task list is untouched (`taskWritten: false`),
 * and the moment the last step is ticked the plan's own `status:` line records
 * that the item is verified.
 */
async function completeStep(args, taskContent, taskStatus, progress) {
  const planContent = readFileIfExists(PLAN_FILE);
  if (planContent === null) {
    return refusal('PLAN_FILE_NOT_FOUND', `${PLAN_FILE} does not exist yet; start an item before ticking its steps.`);
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

  let updatedPlan = markPlanStepDone(planContent, step, true);
  const after = planProgress(updatedPlan);
  const newStatus = typeof args.status === 'string' && args.status.trim() !== ''
    ? args.status.trim()
    : (after.pending === 0 ? 'done — every step verified' : readStatusLine(updatedPlan));
  updatedPlan = replaceStatusLine(updatedPlan, newStatus);

  const planWrite = writeFileVerified(PLAN_FILE, updatedPlan);

  return JSON.stringify({
    status: 'success',
    action: 'step',
    taskFile: TASK_FILE,
    planFile: PLAN_FILE,
    step: step.text,
    planStatus: newStatus || null,
    taskStatus,
    planProgress: after,
    progress,
    taskWritten: false,
    planWritten: Boolean(planWrite),
    message: after.pending === 0
      ? `Ticked the last plan step: ${step.text}. Every step of the current item is verified.`
      : `Ticked plan step: ${step.text}. ${after.pending} step(s) still pending.`
  });
}

export { renderPlan };
export { definition, execute };
