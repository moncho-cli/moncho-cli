import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  TASK_TITLE, PLAN_TITLE, ITEMS_HEADING, STEPS_HEADING, NOTES_HEADING,
  STATUS_STATES, isCanonicalStatus, normalizeStatus, readTitle, extractNotes,
  entriesOf, renderTaskFile, renderPlanFile, validateTrackingFile,
  canonicalizeTrackingFile, trackingTemplate,
} from '../utils/tracking-format.js';
import { definition as updateTaskDefinition } from '../tools/update_task.js';

/**
 * The canonical shape of the two tracking files.
 *
 * The files are authored by one tool, so their shape is a contract: title, a `status:`
 * line from a closed set, and one section of column-0 `- [ ]` entries. These cases fix
 * that contract, and the *upgrade* rule that makes it realistic — an inherited legacy
 * file is re-rendered instead of being rejected, so an operator's existing `task.md`
 * keeps working.
 */

test('the canonical status is one of three states, with the item in flight named', () => {
  assert.deepEqual([...STATUS_STATES], ['pending', 'in progress', 'done']);

  for (const good of ['pending', 'done', 'in progress', 'in progress: item two', 'Done']) {
    assert.equal(isCanonicalStatus(good), true, good);
  }
  for (const bad of ['', '   ', 'wip', 'started', null, undefined]) {
    assert.equal(isCanonicalStatus(bad), false, JSON.stringify(bad));
  }

  // A status is normalised into a canonical form, never left in a dialect.
  assert.equal(normalizeStatus(''), 'pending');
  assert.equal(normalizeStatus('DONE — every step verified'), 'done');
  assert.equal(normalizeStatus('in progress: item one'), 'in progress: item one');
  assert.equal(normalizeStatus('in  progress:item one'), 'in progress: item one');
  assert.equal(normalizeStatus('in progress'), 'in progress');
  // An unrecognised status is kept verbatim: the tool reports it rather than
  // silently rewriting what a human typed.
  assert.equal(normalizeStatus('blocked on review'), 'blocked on review');
});

test('renderTaskFile writes the whole document, from whatever parts it is given', () => {
  const text = renderTaskFile({
    title: TASK_TITLE,
    status: 'in progress: item two',
    items: [{ text: 'item one', done: true }, 'item two'],
    notes: ['left off here'],
  });

  assert.ok(text.startsWith(`${TASK_TITLE}\n\nstatus: in progress: item two\n\n${ITEMS_HEADING}\n\n`));
  assert.ok(text.includes('- [x] item one'));
  assert.ok(text.includes('- [ ] item two'));
  assert.ok(text.includes(`\n${NOTES_HEADING}\n\n- left off here\n`));
  assert.ok(text.endsWith('\n'), 'a text file ends with a newline');

  // An empty list is still a valid document, never a bare heading.
  const empty = renderTaskFile({});
  assert.ok(empty.includes('status: pending'));
  assert.ok(empty.includes('- [ ] (no items recorded)'));
  // A placeholder is a placeholder: it is never re-rendered as a real entry.
  assert.equal(entriesOf(empty).length, 0);
});

test('renderPlanFile titles the plan with the item it is the plan for', () => {
  const fromItem = renderPlanFile({ item: { text: 'wire the store' }, steps: ['one', 'two'] });
  assert.ok(fromItem.startsWith('# wire the store\n'));
  assert.ok(fromItem.includes(`${STEPS_HEADING}\n\n- [ ] one\n- [ ] two\n`));
  assert.ok(!fromItem.includes(ITEMS_HEADING), 'a plan has steps, never items');

  // A plan with no item is still titled, so a file is never anonymous.
  assert.ok(renderPlanFile({}).startsWith(`${PLAN_TITLE}\n`));
});

test('validateTrackingFile reports each broken rule instead of throwing', () => {
  const canonical = renderTaskFile({ items: ['one'] });
  const ok = validateTrackingFile(canonical, { kind: 'task' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.status, 'pending');
  assert.equal(ok.items.length, 1);

  const bare = validateTrackingFile('- [ ] one\n', { kind: 'task' });
  assert.equal(bare.ok, false);
  assert.equal(bare.problems.length, 3, 'no title, no status line, no section heading');
  assert.match(bare.problems[0], /# <title>/);
  assert.match(bare.problems[1], /status:/);
  assert.match(bare.problems[2], /## Items/);

  const dialect = validateTrackingFile(
    '# t\n\nstatus: started\n\n## Items\n\n  - [ ] indented\n* [ ] star\n- no checkbox here\n',
    { kind: 'task' },
  );
  assert.equal(dialect.ok, false);
  assert.ok(dialect.problems.some((p) => p.includes('"status: started"')), 'the status is named');
  assert.ok(dialect.problems.some((p) => p.includes('is indented')), 'indentation is named');
  assert.ok(dialect.problems.some((p) => p.includes('not "* [ ]"')), 'the marker is named');
});

test('a legacy file is upgraded, not rejected, so an operator keeps working', () => {
  const legacy = [
    '- [x] make sure the intent string is not repeated',
    '- [ ] deprecate the main task.md file',
    '',
    'status: in progress: deprecate the main task.md file',
  ].join('\n');

  const upgraded = canonicalizeTrackingFile('task', legacy);
  const checked = validateTrackingFile(upgraded, { kind: 'task' });

  assert.equal(checked.ok, true, `upgraded document must be canonical: ${checked.problems.join('; ')}`);
  assert.equal(checked.items.length, 2, 'no entry is lost in the upgrade');
  assert.deepEqual(checked.items.map((item) => item.done), [true, false]);
  assert.equal(checked.status, 'in progress: deprecate the main task.md file');
  assert.ok(upgraded.startsWith(`${TASK_TITLE}\n`), 'a bare list gains the title it was missing');

  // Upgrading is idempotent: a canonical document comes back byte-identical.
  assert.equal(canonicalizeTrackingFile('task', upgraded), upgraded);

  // An empty or missing file becomes the skeleton, not an error.
  assert.ok(validateTrackingFile(canonicalizeTrackingFile('task', null), { kind: 'task' })
    .problems.some((p) => p.includes('no items recorded')) === false);
  assert.equal(validateTrackingFile(canonicalizeTrackingFile('task', null), { kind: 'task' }).ok, true);
});

test('the human parts of a file survive the upgrade', () => {
  const withNotes = [
    '# My checklist',
    '',
    'status: pending',
    '',
    '## Items',
    '',
    '- [ ] one',
    '',
    '## Notes',
    '',
    '- a human remark',
    '- another one',
  ].join('\n');

  const checked = validateTrackingFile(withNotes, { kind: 'task' });
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.notes, ['a human remark', 'another one']);
  assert.equal(readTitle(withNotes), '# My checklist');
  assert.deepEqual(extractNotes(withNotes), checked.notes);

  // And the notes and the title are rendered back out.
  const kept = canonicalizeTrackingFile('task', withNotes);
  assert.ok(kept.startsWith('# My checklist\n'));
  assert.ok(kept.includes('- a human remark'));
});

test('the template the model is shown is the shape the renderer really writes', () => {
  // One template, three places: the renderer, the tool description the provider is
  // offered, and the system prompt. These cases exist because the prompt described the
  // shape in prose only — a model could follow every sentence and still not know what a
  // well-formed file looks like.
  const task = trackingTemplate('task');
  const plan = trackingTemplate('plan');

  assert.ok(task.startsWith(`${TASK_TITLE}\n\nstatus: <pending | in progress: <item> | done>\n\n${ITEMS_HEADING}\n`));
  assert.ok(task.includes('- [ ] <one item>\n- [x] <a finished item>'));
  assert.ok(task.includes(`\n${NOTES_HEADING}\n\n- <an optional human note>`));

  // The plan is the same skeleton with the plan vocabulary and the item as its title.
  assert.ok(plan.startsWith('# <the item this plan is for>\n'));
  assert.ok(plan.includes(`${STEPS_HEADING}\n`));
  assert.ok(plan.includes('- [ ] <one step>'));
  assert.ok(!plan.includes(ITEMS_HEADING));

  // A file filled in from the template is canonical, so following the template is
  // enough to satisfy the contract the validator enforces.
  const filled = task
    .replace('status: <pending | in progress: <item> | done>', 'status: in progress: item two')
    .replace('- [ ] <one item>', '- [ ] item one')
    .replace('- [x] <a finished item>', '- [x] item two')
    .replace('- <an optional human note>', '- a real note');
  const checked = validateTrackingFile(filled, { kind: 'task' });
  assert.equal(checked.ok, true, checked.problems.join('; '));
  assert.equal(checked.status, 'in progress: item two');
  assert.deepEqual(checked.items.map((item) => item.done), [false, true]);

  // Both texts the model really reads quote this template verbatim, so the three copies
  // cannot drift apart without failing here.
  const prompt = fs.readFileSync(new URL('../config/prompt.md', import.meta.url), 'utf-8');
  assert.ok(prompt.includes(task), 'config/prompt.md must show the task.md template verbatim');
  assert.ok(prompt.includes(plan), 'config/prompt.md must show the implementation_plan.md template verbatim');

  const description = updateTaskDefinition.function.description;
  assert.ok(description.includes(task), 'the update_task description must carry the task template');
  assert.ok(description.includes(plan), 'the update_task description must carry the plan template');
});