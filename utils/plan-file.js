/**
 * The text machinery behind the task-tracking files (`docs/agent/task-tracking`).
 *
 * `task.md` carries the checkbox *items*; `implementation_plan.md` carries the
 * checkbox *steps* of exactly one item. Both files use the same syntax, and both
 * are edited by exactly one tool, so the parsing, the strict selection, the
 * in-place tick and the plan rendering live here: pure string work, no `fs`, no
 * terminal, unit tested on plain content.
 *
 * The split exists because the plan must move **as soon as a step is verified**,
 * not only when a whole item is completed: `tools/update_task.js` keeps the
 * `task.md` bookkeeping and re-exports `renderPlan`, while the step-level editing
 * (`parsePlanSteps`, `findPlanStep`, `markPlanStepDone`, `planProgress`) is what a
 * `step` action calls.
 */

/** The checkbox syntax shared by task.md items and implementation_plan.md steps. */
export const CHECKBOX_PATTERN = /^(\s*)([-*])\s+\[( |x|X)\]\s+(.*)$/;

/** The optional `status:` line of either tracking file. */
export const STATUS_PATTERN = /^\s*status\s*:\s*(.*)$/i;

/**
 * Parse the checkbox lines of a tracking file into an ordered list.
 * @param {string} content
 * @returns {{line: number, indent: string, marker: string, done: boolean, text: string}[]}
 */
export function parseCheckboxItems(content) {
  if (typeof content !== 'string') return [];
  const lines = content.split('\n');
  const items = [];
  // True while the line just read belongs to the entry above: its checkbox line or a
  // continuation of it. A blank line, a heading or any other line ends the entry, so a
  // note under `## Notes` is never glued onto the item above it.
  let attached = false;

  lines.forEach((line, index) => {
    const match = line.match(CHECKBOX_PATTERN);
    if (match) {
      items.push({
        line: index + 1,
        indent: match[1],
        marker: match[2],
        done: match[3].toLowerCase() === 'x',
        text: match[4].trim()
      });
      attached = true;
      return;
    }
    // A wrapped entry is one entry: its continuation lines are indented, carry no
    // checkbox of their own, and are folded back into the text. Without this an entry
    // written across three lines came back as a single line ending mid-sentence, which
    // reads like the harness cut the text rather than re-rendered the document.
    //
    // The fold only applies while the continuation is *contiguous* with the entry: a
    // blank line, a heading or any other line ends it. Without that guard the fold ran
    // to the end of the document, so a note in `## Notes` was absorbed by the last item
    // and the item's text grew a sentence nobody wrote into it.
    const last = items[items.length - 1];
    if (last && attached && /^[ \t]+\S/.test(line)) {
      last.text = `${last.text} ${line.trim()}`;
      return;
    }
    attached = false;
  });

  return items;
}

/** The steps of the plan file: its checkbox lines, in file order. */
export function parsePlanSteps(content) {
  return parseCheckboxItems(content);
}

/**
 * Find the checkbox entry matching `query` (by 1-based index or unique substring).
 *
 * Selection is deliberately strict: an index outside the list fails, and a
 * substring matching zero or more than one entry fails with `code`. Ambiguity is
 * never resolved by guessing, because both files are edited in place.
 *
 * @returns {{item: object|null, error: string|null, code: string|null}}
 */
export function findCheckboxItem(items, {
  index,
  query,
  label = 'item',
  queryParam = 'item',
  code = 'ITEM_NOT_FOUND'
} = {}) {
  const capitalized = label.charAt(0).toUpperCase() + label.slice(1);

  if (Number.isInteger(index)) {
    if (index < 1 || index > items.length) {
      return { item: null, code, error: `${capitalized} index ${index} is out of range (1..${items.length}).` };
    }
    return { item: items[index - 1], error: null, code: null };
  }

  const needle = String(query ?? '').trim().toLowerCase();
  if (needle === '') {
    return {
      item: null,
      code,
      error: `Provide either "index" or "${queryParam}" (a substring of the ${label} text).`
    };
  }

  const matches = items.filter((item) => item.text.toLowerCase().includes(needle));
  if (matches.length === 0) return { item: null, code, error: `No ${label} matches ${JSON.stringify(query)}.` };
  if (matches.length > 1) {
    return {
      item: null,
      code,
      error: `Ambiguous ${label} ${JSON.stringify(query)}; it matches ${matches.length} ${label}s. Use "index" instead.`
    };
  }
  return { item: matches[0], error: null, code: null };
}

/** The plan step matching `query`: the same strict rule as a task item. */
export function findPlanStep(steps, { index, query } = {}) {
  return findCheckboxItem(steps, {
    index,
    query,
    label: 'plan step',
    queryParam: 'step',
    code: 'STEP_NOT_FOUND'
  });
}

/**
 * Tick (or untick) one checkbox entry in place, preserving indentation and marker.
 *
 * A line that no longer matches the checkbox syntax at its recorded position is a
 * hard error rather than a blind edit: the caller recorded a position, so a
 * mismatch means the file moved under it.
 */
export function markCheckboxItem(content, item, done = true, { label = 'checkbox item' } = {}) {
  const lines = String(content).split('\n');
  const target = lines[item.line - 1];
  if (!CHECKBOX_PATTERN.test(target)) {
    throw new Error(`Line ${item.line} no longer looks like a ${label}; refusing to edit.`);
  }
  lines[item.line - 1] = target.replace(CHECKBOX_PATTERN, (_m, indent, marker, _state, text) =>
    `${indent}${marker} [${done ? 'x' : ' '}] ${text}`
  );
  return lines.join('\n');
}

/** Tick one plan step, in place. */
export function markPlanStepDone(content, step, done = true) {
  return markCheckboxItem(content, step, done, { label: 'plan step' });
}

/** Read the `status:` line of a tracking file, if present. */
export function readStatusLine(content) {
  for (const line of String(content ?? '').split('\n')) {
    const match = line.match(STATUS_PATTERN);
    if (match) return match[1].trim();
  }
  return null;
}

/** Rewrite (or insert) the `status:` line of a tracking file. */
export function replaceStatusLine(content, status) {
  const value = String(status ?? '').trim();
  if (value === '') return content;
  const lines = String(content).split('\n');
  const index = lines.findIndex((line) => STATUS_PATTERN.test(line));
  if (index >= 0) lines[index] = `status: ${value}`;
  else lines.splice(1, 0, `status: ${value}`);
  return lines.join('\n');
}

/** How far the plan has got: its steps, counted. */
export function planProgress(content) {
  const steps = parsePlanSteps(content);
  return {
    total: steps.length,
    done: steps.filter((step) => step.done).length,
    pending: steps.filter((step) => !step.done).length
  };
}

/**
 * Render the per-cycle implementation plan mandated by task.md:
 * "for each task reset and write your steps in implementation_plan.md".
 *
 * Pure: the tool supplies the item and the steps, this returns the exact bytes.
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
    steps.forEach((step) => lines.push(`- [ ] ${String(step).trim()}`));
  }

  if (notes.length > 0) {
    lines.push('', '## Notes', '');
    notes.forEach((note) => lines.push(`- ${String(note).trim()}`));
  }

  lines.push('');
  return lines.join('\n');
}
