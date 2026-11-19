import { parseCheckboxItems, readStatusLine, CHECKBOX_PATTERN } from './plan-file.js';

/**
 * The canonical shape of the two tracking files (`docs/agent/task-tracking`).
 *
 * The files are authored by exactly one tool, so their shape is not a matter of taste:
 * it is a **contract** the tool writes and the next call re-reads. One skeleton for
 * both, so a model never has to guess what a well-formed tracking file looks like:
 *
 *     # <title>
 *
 *     status: <pending | in progress: <item> | done>
 *
 *     ## Items          (## Steps in the plan)
 *
 *     - [ ] one entry
 *     - [x] a finished entry
 *
 *     ## Notes          (optional, human commentary)
 *
 *     - a note
 *
 * Three rules make it worth enforcing:
 *
 *  - the **title**, the **status line** and the **section heading** must exist, so a
 *    file is never a bare list of checkboxes that loses what it is about;
 *  - entries are `- [ ]` / `- [x]` at column 0 — an indented or `*`-marked entry is a
 *    different document, not a nested one;
 *  - a **status** is one of the canonical forms, so "where am I" is machine-readable.
 *
 * The rules are reported, not enforced destructively: a legacy file (a bare checkbox
 * list) still *reads*, it is simply reported as non-canonical and upgraded the next
 * time one is created or the tool writes it. Pure text work: no `fs`, no terminal.
 */

/** The title a checklist starts with when the harness creates it. */
export const TASK_TITLE = '# Task list';
/** The title a plan starts with when the harness creates it. */
export const PLAN_TITLE = '# Plan';
/** The heading that holds the items of `task.md`. */
export const ITEMS_HEADING = '## Items';
/** The heading that holds the steps of `implementation_plan.md`. */
export const STEPS_HEADING = '## Steps';
/** The optional heading that holds human commentary in either file. */
export const NOTES_HEADING = '## Notes';
/** The canonical status states; `in progress` may be followed by `: <item>`. */
export const STATUS_STATES = Object.freeze(['pending', 'in progress', 'done']);

const TITLE_PATTERN = /^#[ \t]+(\S.*)$/m;
const HEADING_PATTERN = /^##[ \t]+(\S.*)$/m;

/** The per-kind vocabulary: which heading, and what one entry is called. */
function sectionOf(kind) {
  return kind === 'plan'
    ? { heading: STEPS_HEADING, entry: 'step', headingTitle: 'Steps' }
    : { heading: ITEMS_HEADING, entry: 'item', headingTitle: 'Items' };
}

/**
 * The skeleton **as a model is shown it**, with placeholders.
 *
 * This is the one template the whole harness quotes: `config/prompt.md` shows these exact
 * blocks and `update_task`'s description carries them, so a model is taught the shape
 * the renderer really writes instead of inferring it from prose. The copies cannot
 * drift — `tests/tracking-format.test.js` fails when either text stops matching this
 * function's output.
 *
 * @param {'task'|'plan'} [kind] which file's skeleton
 * @returns {string}
 */
export function trackingTemplate(kind = 'task') {
  const { heading, entry } = sectionOf(kind);
  return [
    kind === 'plan' ? '# <the item this plan is for>' : TASK_TITLE,
    '',
    'status: <pending | in progress: <item> | done>',
    '',
    heading,
    '',
    `- [ ] <one ${entry}>`,
    `- [x] <a finished ${entry}>`,
    '',
    NOTES_HEADING,
    '',
    '- <an optional human note>',
  ].join('\n');
}

/**
 * True when `status` is one of the canonical forms the contract allows.
 * `in progress: something` names the item in flight, which is why it is a form.
 */
export function isCanonicalStatus(status) {
  const value = String(status ?? '').trim().toLowerCase();
  if (value === '') return false;
  if (value === 'pending' || value === 'done') return true;
  return value === 'in progress' || value.startsWith('in progress:');
}

/** Normalise a status the caller supplied into a canonical one, keeping it readable. */
export function normalizeStatus(status) {
  const value = String(status ?? '').trim();
  if (value === '') return 'pending';
  if (/^done\b/i.test(value)) return 'done';
  if (/^pending\b/i.test(value)) return 'pending';
  if (/^in\s*progress\s*:?\s*(.*)$/i.test(value)) {
    const rest = value.replace(/^in\s*progress\s*:?\s*/i, '').trim();
    return rest === '' ? 'in progress' : `in progress: ${rest}`;
  }
  // An unrecognised status is kept verbatim: the tool reports it as a problem instead
  // of silently rewriting what a human typed.
  return value;
}

/** The first `# title` line of a document, or `null` when it has none. */
export function readTitle(content) {
  for (const line of String(content ?? '').split('\n')) {
    const match = line.match(TITLE_PATTERN);
    if (match) return `# ${match[1].trim()}`;
  }
  return null;
}

/** The bullets of the `## Notes` section, in file order. */
export function extractNotes(content) {
  const notes = [];
  let inNotes = false;
  for (const line of String(content ?? '').split('\n')) {
    const heading = line.match(HEADING_PATTERN);
    if (heading) {
      inNotes = heading[1].trim().toLowerCase() === 'notes';
      continue;
    }
    if (!inNotes) continue;
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) notes.push(bullet[1].trim());
  }
  return notes;
}

/** The checkbox entries of a document as `{ text, done }`, ready to be re-rendered. */
export function entriesOf(content) {
  return parseCheckboxItems(content)
    .map((item) => ({ text: item.text, done: item.done }))
    .filter((entry) => entry.text !== '' && !/^\((no|not) .*recorded\)$/.test(entry.text));
}

/**
 * Render one `- [x] text` line, or `null` when there is nothing to render.
 * The placeholder entries the skeleton carries are dropped, never re-rendered.
 */
function entryLine(entry) {
  const text = String(typeof entry === 'string' ? entry : entry?.text ?? '').trim();
  if (text === '') return null;
  if (/^\((no|not) .*recorded\)$/.test(text)) return null;
  const done = typeof entry === 'object' && entry !== null ? Boolean(entry.done) : false;
  return `- [${done ? 'x' : ' '}] ${text}`;
}

/** The shared skeleton: title, status, one section of entries, optional notes. */
function renderDocument({ kind, title, status, entries, notes }) {
  const { heading } = sectionOf(kind);
  const lines = [title, '', `status: ${normalizeStatus(status)}`, '', heading, ''];

  const rendered = (Array.isArray(entries) ? entries : []).map(entryLine).filter(Boolean);
  lines.push(...(rendered.length === 0 ? [`- [ ] (no ${sectionOf(kind).entry}s recorded)`] : rendered));

  const bullets = (Array.isArray(notes) ? notes : [])
    .map((note) => String(note ?? '').trim())
    .filter(Boolean);
  if (bullets.length > 0) lines.push('', NOTES_HEADING, '', ...bullets.map((note) => `- ${note}`));

  lines.push('');
  return lines.join('\n');
}

/**
 * Render `task.md` from its parts: the canonical bytes, and the only way the harness
 * ever writes this file.
 *
 * @param {{title?: string, status?: string, items?: (string|object)[], notes?: string[]}} parts
 * @returns {string}
 */
export function renderTaskFile({ title = TASK_TITLE, status = 'pending', items = [], notes = [] } = {}) {
  return renderDocument({ kind: 'task', title: title || TASK_TITLE, status, entries: items, notes });
}

/**
 * Render `implementation_plan.md` from its parts, in the same skeleton.
 *
 * The `{ item, status, steps, notes }` shape `update_task` passes is accepted too:
 * the item is the title of the plan, because a plan is the plan *for one item*.
 *
 * @param {{title?: string, item?: object, status?: string, steps?: (string|object)[], notes?: string[]}} parts
 * @returns {string}
 */
export function renderPlanFile({ title = null, item = null, status = 'pending', steps = [], notes = [] } = {}) {
  const resolved = title || (item?.text ? `# ${String(item.text).trim()}` : PLAN_TITLE);
  return renderDocument({ kind: 'plan', title: resolved, status, entries: steps, notes });
}

/**
 * Check a tracking file against the contract.
 *
 * @param {string} content the file as it stands
 * @param {{kind?: 'task'|'plan'}} [options] which file it is
 * @returns {{ok: boolean, kind: string, problems: string[], status: string|null, notes: string[], items: object[]}}
 */
export function validateTrackingFile(content, { kind = 'task' } = {}) {
  const text = typeof content === 'string' ? content : '';
  const { heading, entry, headingTitle } = sectionOf(kind);
  const problems = [];

  if (!TITLE_PATTERN.test(text)) {
    problems.push(`missing the "# <title>" line (a ${kind} file starts with one)`);
  }

  const status = readStatusLine(text);
  if (status === null) problems.push('missing the "status:" line');
  else if (!isCanonicalStatus(status)) {
    problems.push(`"status: ${status}" is not one of ${STATUS_STATES.join(', ')} (or "in progress: <item>")`);
  }

  const hasSection = text.split('\n').some((line) => {
    const match = line.match(HEADING_PATTERN);
    return Boolean(match) && match[1].trim().toLowerCase() === headingTitle.toLowerCase();
  });
  if (!hasSection) problems.push(`missing the "${heading}" section heading`);

  const items = parseCheckboxItems(text);
  if (items.length === 0) problems.push(`no "- [ ] ${entry}" lines`);

  for (const item of items) {
    if (item.indent) problems.push(`line ${item.line}: the ${entry} is indented; entries start at column 0`);
    if (item.marker !== '-') problems.push(`line ${item.line}: use "- [ ]" or "- [x]", not "${item.marker} [ ]"`);
  }

  for (const line of text.split('\n')) {
    if (/\[[ xX]\]/.test(line) && !CHECKBOX_PATTERN.test(line)) {
      problems.push(`malformed checkbox: ${JSON.stringify(line.trim())}`);
    }
  }

  return { ok: problems.length === 0, kind, problems, status, notes: extractNotes(text), items };
}

/**
 * Re-render whatever was inherited as the canonical document for that kind.
 * A `null` or legacy seed produces a valid document instead of being inherited as-is.
 *
 * @param {'task'|'plan'} kind which file
 * @param {string|null} content whatever the file held before
 * @returns {string}
 */
export function canonicalizeTrackingFile(kind, content) {
  const title = readTitle(content) || (kind === 'plan' ? PLAN_TITLE : TASK_TITLE);
  const status = normalizeStatus(readStatusLine(content) ?? 'pending');
  const entries = entriesOf(content);
  const notes = extractNotes(content);
  return kind === 'plan'
    ? renderPlanFile({ title, status, steps: entries, notes })
    : renderTaskFile({ title, status, items: entries, notes });
}