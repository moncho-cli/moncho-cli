import { TASK_FILE, PLAN_FILE } from '../config/constants.js';
import { readTaskContent, readPlanContent, writeTaskContent, writePlanContent, trackingPaths } from '../utils/tracking-store.js';
import { completeStep, refusal } from '../utils/tracking-step.js';
import { defineTool } from '../utils/tool-schema.js';
import { resetTaskPulse, notifyTrackingUpdate } from '../utils/host.js';
import { parseCheckboxItems, findCheckboxItem, readStatusLine, planProgress } from '../utils/plan-file.js';
import {
  renderTaskFile, renderPlanFile, readTitle, extractNotes, normalizeStatus, trackingTemplate,
} from '../utils/tracking-format.js';

/**
 * `update_task` implements the tracking protocol in one place:
 *
 *   1. read the item list (the `- [ ]` / `- [x]` entries of the session's `task.md`),
 *   2. mark exactly one item done (or advance its `status:` line),
 *   3. report the next item in line,
 *   4. reset the plan for that next item, and
 *   5. tick one plan *step* as soon as it is verified (`step`).
 *
 * It is deliberately deterministic: the model supplies the text, the tool does the
 * bookkeeping and refuses ambiguous matches (0 or >1 entries). Every write is
 * **re-rendered** through `utils/tracking-format.js`, so the files on disk are always
 * the canonical document — title, `status:` line, one section of entries — no matter
 * what the model or a human left there. Which folder those files live in is
 * `utils/tracking-store.js`'s decision: one pair per session.
 *
 * The pure text machinery is elsewhere, so the whole protocol is unit tested on plain
 * strings: `utils/plan-file.js` (parsing, strict selection), `utils/tracking-format.js`
 * (the canonical shape) and `utils/tracking-step.js` (the `step` action).
 */

/** The items of `task.md`: its checkbox entries. */
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

/** Tick or untick one item line in place, preserving its marker. */
export function markItemDone(content, item, done = true) {
  const entries = parseCheckboxItems(content).map((entry) => ({
    text: entry.text,
    done: entry.line === item.line ? done : entry.done,
  }));
  return renderTaskFile({
    title: readTitle(content) || undefined,
    status: normalizeStatus(readStatusLine(content) ?? 'pending'),
    items: entries,
    notes: extractNotes(content),
  });
}

/** Next not-done item after the given one (by line order). */
export function nextPendingItem(items, afterItem) {
  const candidates = afterItem
    ? items.filter((item) => item.line > afterItem.line && !item.done)
    : items.filter((item) => !item.done);
  return candidates[0] || null;
}

/** The canonical plan body, for callers that only know this tool. */
export function renderPlan(parts = {}) {
  return renderPlanFile(parts);
}

const { definition, execute } = defineTool({
  name: 'update_task',
  description:
    `Mark one item of the session's ${TASK_FILE} as done (or update its "status:" line), tick one verified step of ${PLAN_FILE}, report the next pending item, and reset ${PLAN_FILE} with the steps for that item. This is the task-tracking loop. Both files are written in one canonical shape, which is what every write re-renders — a malformed draft is normalised, never kept — and this tool is the only thing that writes them; every reply names the exact taskFile/planFile paths.\n\n${TASK_FILE}:\n\n${trackingTemplate('task')}\n\n${PLAN_FILE}, titled with the item the plan is for:\n\n${trackingTemplate('plan')}\n\nNever author either file with write_file (the draft is normalised) or patch_file (refused as tool-owned): this tool owns them.`,
  parameters: {
    properties: {
      action: {
        type: 'string',
        enum: ['complete', 'start', 'step', 'status', 'list'],
        description:
          'complete = mark an item done and start the next one; start = reset the plan for an item; step = tick one verified step of the current plan; status = only update the status line; list = report progress and the format check without editing.'
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
        description: 'New value for the "status:" line: "pending", "done", or "in progress: <item>".'
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

    // One rule decides where the checklist comes from (utils/tracking-store.js).
    const taskContent = readTaskContent();
    if (taskContent === null || taskContent === undefined) {
      return refusal('TASK_FILE_NOT_FOUND', `There is no ${TASK_FILE} for this session.`);
    }

    const items = parseTaskItems(taskContent);
    const currentStatus = readTaskStatus(taskContent);
    const progress = {
      total: items.length,
      done: items.filter((item) => item.done).length,
      pending: items.filter((item) => !item.done).length
    };

    if (action === 'list') {
      const planContent = readPlanContent();
      const paths = trackingPaths();
      return JSON.stringify({
        status: 'ok',
        action,
        taskFile: paths.task,
        planFile: paths.plan,
        taskStatus: currentStatus,
        progress,
        planProgress: planContent === null ? null : planProgress(planContent),
        items: items.map((item, i) => ({ index: i + 1, done: item.done, text: item.text })),
        next: nextPendingItem(items)?.text || null
      });
    }

    // `step` only ever touches the plan, so it is its own module.
    if (action === 'step') {
      return await completeStep(args, { taskStatus: currentStatus, progress, paths: trackingPaths() });
    }

    const selection = action === 'status'
      ? { item: null, error: null }
      : findTaskItem(items, { index: args.index, query: args.item });
    if (selection.error) {
      return refusal('ITEM_NOT_FOUND', selection.error, {
        items: items.map((item, i) => ({ index: i + 1, done: item.done, text: item.text }))
      });
    }

    let completed = null;
    let nextItem = null;
    let done = items.map((item) => ({ text: item.text, done: item.done, line: item.line }));

    if (action === 'complete') {
      completed = selection.item;
      if (completed.done) {
        return JSON.stringify({ status: 'skipped', code: 'ALREADY_DONE', message: `Item ${JSON.stringify(completed.text)} is already marked done.`, progress });
      }
      done = done.map((entry) => (entry.text === completed.text ? { ...entry, done: true } : entry));
      nextItem = nextPendingItem(done, completed);
    } else {
      nextItem = selection.item || nextPendingItem(items);
    }

    const newStatus = action === 'complete'
      ? (nextItem ? `in progress: ${nextItem.text}` : 'done')
      : (typeof args.status === 'string' && args.status.trim() !== '' ? args.status.trim() : currentStatus);

    // The checklist is re-rendered, never patched: the title and the human notes of
    // the file survive, and everything else is the canonical document.
    const taskWrite = writeTaskContent(renderTaskFile({
      title: readTitle(taskContent) || undefined,
      status: newStatus || 'pending',
      items: done,
      notes: extractNotes(taskContent),
    }));

    const planTarget = nextItem || completed;
    const planWrite = writePlanContent(renderPlanFile({
      item: planTarget,
      status: newStatus || 'in progress',
      steps: Array.isArray(args.steps) ? args.steps : [],
      notes: Array.isArray(args.notes) ? args.notes : []
    }));

    // A completed item is one of the two moments the model-call pulse starts again
    // from 0 (docs/context/call-pulse): the counter follows the work, not the
    // process. `status` is a metadata edit and `step` ticks a step of the item still
    // in flight, so neither of them resets anything.
    const pulseReset = action === 'complete' ? resetTaskPulse('item-completed') : false;

    // The user watches the conversation, not the two files, so a milestone the tool just
    // wrote is announced in the transcript as a `[Tracking]` row (app/tracking-notice.js),
    // in the palette's own bright-green + bold. Presentation only: the line is not a
    // chunk, so it never reaches the model or a session file, and with no front end
    // registered (a bare tool call) the report is a no-op.
    const trackingLines = notifyTrackingUpdate({
      action,
      completed: completed ? completed.text : null,
      next: nextItem ? nextItem.text : null,
      status: newStatus || currentStatus,
      progress: { total: items.length, done: done.filter((item) => item.done).length },
      planTarget: planTarget ? planTarget.text : null,
      planSteps: Array.isArray(args.steps) ? args.steps.length : 0,
    });

    return JSON.stringify({
      status: 'success',
      action,
      taskFile: taskWrite?.path ?? trackingPaths().task,
      planFile: planWrite?.path ?? trackingPaths().plan,
      completed: completed ? completed.text : null,
      next: nextItem ? nextItem.text : null,
      taskStatus: newStatus || currentStatus,
      progress: {
        total: items.length,
        done: done.filter((item) => item.done).length,
        pending: done.filter((item) => !item.done).length
      },
      taskWritten: Boolean(taskWrite),
      planWritten: Boolean(planWrite),
      // True when this call put the live model-call pulse back to 0.
      pulseReset,
      // The `[Tracking]` rows the transcript showed, so the user (and the tests) can see
      // exactly what was announced. Empty when no front end is registered.
      trackingLines,
      message: completed
        ? `Marked done: ${completed.text}. Next: ${nextItem ? nextItem.text : 'none'}.`
        : `Plan reset for: ${planTarget ? planTarget.text : 'harness work'}.`
    });
  }
});

export { definition, execute };