import {
  TASK_FILE,
  PLAN_FILE
} from '../config/constants.js';
import { readFileIfExists, writeFileVerified } from '../utils/file-io.js';
import { defineTool } from '../utils/tool-schema.js';

/**
 * `update_task` implements the task.md protocol in one place:
 *
 *   1. read the item list (checkbox lines like `- [ ] ...` / `- [x] ...`),
 *   2. mark exactly one item done (or advance the "status:" line),
 *   3. print the next item in line, and
 *   4. reset implementation_plan.md with the steps for that next item.
 *
 * It is intentionally deterministic: the model supplies the plan text, the tool
 * does the file bookkeeping with verified atomic writes and refuses ambiguous
 * matches (0 or >1 items).
 */

const ITEM_PATTERN = /^(\s*)([-*])\s+\[( |x|X)\]\s+(.*)$/;
const STATUS_PATTERN = /^\s*status\s*:\s*(.*)$/i;

/** Parse task.md into an ordered list of checkbox items. */
export function parseTaskItems(content) {
  if (typeof content !== 'string') return [];
  return content.split('\n').flatMap((line, index) => {
    const match = line.match(ITEM_PATTERN);
    if (!match) return [];
    return [{
      line: index + 1,
      indent: match[1],
      marker: match[2],
      done: match[3].toLowerCase() === 'x',
      text: match[4].trim()
    }];
  });
}

/** Read the `status:` line, if present. */
export function readTaskStatus(content) {
  for (const line of String(content ?? '').split('\n')) {
    const match = line.match(STATUS_PATTERN);
    if (match) return match[1].trim();
  }
  return null;
}

/**
 * Find the checkbox item matching `query` (by 1-based item index or substring).
 * @returns {{item: object|null, error: string|null}}
 */
export function findTaskItem(items, { index, query }) {
  if (Number.isInteger(index)) {
    if (index < 1 || index > items.length) {
      return { item: null, error: `Item index ${index} is out of range (1..${items.length}).` };
    }
    return { item: items[index - 1], error: null };
  }

  const needle = String(query ?? '').trim().toLowerCase();
  if (needle === '') return { item: null, error: 'Provide either "index" or "item" (a substring of the task text).' };

  const matches = items.filter((item) => item.text.toLowerCase().includes(needle));
  if (matches.length === 0) return { item: null, error: `No task item matches ${JSON.stringify(query)}.` };
  if (matches.length > 1) {
    return { item: null, error: `Ambiguous item ${JSON.stringify(query)}; it matches ${matches.length} items. Use "index" instead.` };
  }
  return { item: matches[0], error: null };
}

/** Mark the given item line as done (or undone), preserving indentation and marker. */
export function markItemDone(content, item, done = true) {
  const lines = String(content).split('\n');
  const target = lines[item.line - 1];
  if (!ITEM_PATTERN.test(target)) {
    throw new Error(`Task line ${item.line} no longer looks like a checkbox item; refusing to edit.`);
  }
  lines[item.line - 1] = target.replace(ITEM_PATTERN, (_m, indent, marker, _state, text) =>
    `${indent}${marker} [${done ? 'x' : ' '}] ${text}`
  );
  return lines.join('\n');
}

/** Next not-done item after the given one (by line order). */
export function nextPendingItem(items, afterItem) {
  const candidates = afterItem
    ? items.filter((item) => item.line > afterItem.line && !item.done)
    : items.filter((item) => !item.done);
  return candidates[0] || null;
}

/**
 * Render the per-cycle implementation plan mandated by task.md:
 * "for each task reset and write your steps in implementation_plan.md".
 */
export function renderPlan({ item, status, steps = [], notes = [] }) {
  const header = item
    ? `# ${item.text}`
    : '# Harness work';

  const lines = [
    header,
    '',
    `status: ${status || 'in progress'}`,
    '',
    '## Steps',
    ''
  ];

  if (steps.length === 0) {
    lines.push('- [ ] (no steps recorded)');
  } else {
    steps.forEach((step, i) => lines.push(`- [ ] ${String(step).trim()}`));
  }

  if (notes.length > 0) {
    lines.push('', '## Notes', '');
    notes.forEach((note) => lines.push(`- ${String(note).trim()}`));
  }

  lines.push('');
  return lines.join('\n');
}

const { definition, execute } = defineTool({
  name: 'update_task',
  description:
    `Mark one item in ${TASK_FILE} as done (or update its "status:" line), report the next pending item, and rewrite ${PLAN_FILE} with the steps for that item. This is the task-tracking loop required by task.md.`,
  parameters: {
    properties: {
      action: {
        type: 'string',
        enum: ['complete', 'start', 'status', 'list'],
        description: 'complete = mark an item done and start the next one; start = reset the plan for an item; status = only update the status line; list = report progress without editing.'
      },
      item: {
        type: 'string',
        description: 'Substring of the task text to act on (must match exactly one item).'
      },
      index: {
        type: 'integer',
        description: '1-based index of the checkbox item to act on (alternative to "item").'
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
    if (!['complete', 'start', 'status', 'list'].includes(action)) {
      return JSON.stringify({
        status: 'error',
        code: 'INVALID_ACTION',
        message: `Unknown action ${JSON.stringify(action)}. Use complete, start, status or list.`
      });
    }

    const taskContent = readFileIfExists(TASK_FILE);
    if (taskContent === null) {
      return JSON.stringify({ status: 'error', code: 'TASK_FILE_NOT_FOUND', message: `${TASK_FILE} does not exist.` });
    }

    const items = parseTaskItems(taskContent);
    const currentStatus = readTaskStatus(taskContent);
    const progress = {
      total: items.length,
      done: items.filter((item) => item.done).length,
      pending: items.filter((item) => !item.done).length
    };

    if (action === 'list') {
      return JSON.stringify({
        status: 'ok',
        action,
        taskFile: TASK_FILE,
        taskStatus: currentStatus,
        progress,
        items: items.map((item, i) => ({ index: i + 1, done: item.done, text: item.text })),
        next: nextPendingItem(items)?.text || null
      });
    }

    const selection = action === 'status' ? { item: null, error: null } : findTaskItem(items, { index: args.index, query: args.item });
    if (selection.error) {
      return JSON.stringify({ status: 'error', code: 'ITEM_NOT_FOUND', message: selection.error, items: items.map((item, i) => ({ index: i + 1, done: item.done, text: item.text })) });
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

    if (newStatus) {
      const lines = updatedTask.split('\n');
      const statusIndex = lines.findIndex((line) => STATUS_PATTERN.test(line));
      if (statusIndex >= 0) {
        lines[statusIndex] = `status: ${newStatus}`;
      } else {
        lines.splice(1, 0, `status: ${newStatus}`);
      }
      updatedTask = lines.join('\n');
    }

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

export { definition, execute };
