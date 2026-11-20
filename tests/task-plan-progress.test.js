import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  execute as updateTaskExecute,
  parseTaskItems,
  renderPlan
} from '../tools/update_task.js';
import {
  parsePlanSteps,
  findPlanStep,
  markPlanStepDone,
  planProgress,
  readStatusLine,
  replaceStatusLine
} from '../utils/plan-file.js';

/**
 * The plan must move *while* an item is in flight (task-backlog: "implementation-plan.md
 * should be updated more frequently, as soon as items are done and verified"), so these
 * cases prove the `step` action and the pure helpers behind it: the step-level parsing,
 * the strict selection, the in-place tick, and the fact that only the plan is written.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-plan-test-'));
process.chdir(root);

function writeFile(name, content) {
  fs.mkdirSync(path.dirname(name), { recursive: true });
  fs.writeFileSync(name, content, 'utf-8');
}

const read = (name) => fs.readFileSync(name, 'utf-8');

const PLAN = [
  '# item one',
  '',
  'status: in progress: item one',
  '',
  '## Steps',
  '',
  '- [ ] write the module',
  '- [ ] wire the tool',
  '- [ ] prove it',
  ''
].join('\n');

function seed({ plan = PLAN, task = '- [ ] item one\n- [ ] item two\n' } = {}) {
  writeFile('task.md', task);
  writeFile('implementation_plan.md', plan);
}

// ---------------------------------------------------------------------------
// The pure plan-file helpers
// ---------------------------------------------------------------------------

test('parsePlanSteps reads the checkbox syntax of the plan', () => {
  const steps = parsePlanSteps(PLAN);
  assert.deepEqual(steps.map((step) => step.text), ['write the module', 'wire the tool', 'prove it']);
  assert.deepEqual(steps.map((step) => step.done), [false, false, false]);
  assert.deepEqual(steps.map((step) => step.line), [7, 8, 9]);
  assert.deepEqual(parsePlanSteps(''), []);
  assert.deepEqual(parsePlanSteps(null), []);
});

test('parsePlanSteps folds a wrapped entry into the one entry it is', () => {
  // A plan or checklist entry written across several lines is one entry, not a line
  // with the rest dropped: the continuation lines are indented and carry no checkbox.
  const wrapped = [
    '# item one',
    '',
    'status: in progress',
    '',
    '## Steps',
    '',
    '- [ ] write the module that keeps a long entry whole',
    '      instead of cutting it in half',
    '      when the file is re-rendered',
    '- [ ] prove it',
    '',
  ].join('\n');

  const steps = parsePlanSteps(wrapped);
  assert.equal(steps.length, 2, 'a continuation is not a step of its own');
  assert.equal(
    steps[0].text,
    'write the module that keeps a long entry whole instead of cutting it in half when the file is re-rendered'
  );
  assert.equal(steps[1].text, 'prove it');
});

test('parsePlanSteps ignores the prose and the headings of a plan', () => {
  const steps = parsePlanSteps('# title\n\nstatus: in progress\n\n## Notes\n\n- a note\n- [x] a step\n');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].text, 'a step');
  assert.equal(steps[0].done, true);
});

test('findPlanStep selects one step by index or by unique substring', () => {
  const steps = parsePlanSteps(PLAN);

  assert.equal(findPlanStep(steps, { index: 2 }).item.text, 'wire the tool');
  assert.equal(findPlanStep(steps, { query: 'prove' }).item.text, 'prove it');
  assert.equal(findPlanStep(steps, { query: 'PROVE' }).item.text, 'prove it', 'matching is case-insensitive');

  const outOfRange = findPlanStep(steps, { index: 9 });
  assert.equal(outOfRange.code, 'STEP_NOT_FOUND');
  assert.match(outOfRange.error, /out of range/);

  const missing = findPlanStep(steps, { query: 'nothing like this' });
  assert.equal(missing.code, 'STEP_NOT_FOUND');

  const ambiguous = findPlanStep(parsePlanSteps('- [ ] step a\n- [ ] step b\n'), { query: 'step' });
  assert.equal(ambiguous.code, 'STEP_NOT_FOUND');
  assert.match(ambiguous.error, /Ambiguous/);

  assert.equal(findPlanStep(steps, {}).code, 'STEP_NOT_FOUND', 'no selector is a refusal, not a guess');
});

test('markPlanStepDone ticks one line in place and leaves the rest byte-identical', () => {
  const steps = parsePlanSteps(PLAN);
  const updated = markPlanStepDone(PLAN, steps[1], true);

  assert.ok(updated.includes('- [x] wire the tool'));
  assert.ok(updated.includes('- [ ] write the module'));
  assert.ok(updated.includes('- [ ] prove it'));
  assert.equal(updated.split('\n').length, PLAN.split('\n').length);

  const unticked = markPlanStepDone(updated, parsePlanSteps(updated)[1], false);
  assert.equal(unticked, PLAN, 'unticking restores the original bytes');

  assert.throws(
    () => markPlanStepDone('# nothing here\n', { line: 1, text: 'ghost' }, true),
    /refusing to edit/
  );
});

test('planProgress and the status line summarise the plan', () => {
  assert.deepEqual(planProgress(PLAN), { total: 3, done: 0, pending: 3 });
  assert.deepEqual(planProgress('# x\n- [x] a\n- [ ] b\n'), { total: 2, done: 1, pending: 1 });

  assert.equal(readStatusLine(PLAN), 'in progress: item one');
  assert.equal(readStatusLine('# no status line\n'), null);
  assert.ok(replaceStatusLine(PLAN, 'done').includes('status: done'));
  assert.ok(replaceStatusLine('# x\n- [ ] a\n', 'in progress').startsWith('# x\nstatus: in progress\n'));
});

// ---------------------------------------------------------------------------
// update_task action "step"
// ---------------------------------------------------------------------------

test('the plan is reset for an item and its steps tick as they are verified', async () => {
  seed();

  const started = JSON.parse(await updateTaskExecute({
    action: 'start',
    item: 'item one',
    steps: ['write the module', 'wire the tool', 'prove it'],
    intent: 'start item one'
  }));
  assert.equal(started.status, 'success');
  assert.deepEqual(parsePlanSteps(read('implementation_plan.md')).map((s) => s.text),
    ['write the module', 'wire the tool', 'prove it']);

  const ticked = JSON.parse(await updateTaskExecute({
    action: 'step',
    step: 'write the module',
    intent: 'record the module as done'
  }));
  assert.equal(ticked.status, 'success');
  assert.equal(ticked.step, 'write the module');
  assert.deepEqual(ticked.planProgress, { total: 3, done: 1, pending: 2 });
  assert.equal(ticked.taskWritten, false, 'ticking a step never rewrites the task list');
  assert.equal(ticked.planWritten, true);

  assert.ok(read('implementation_plan.md').includes('- [x] write the module'));
  assert.ok(read('implementation_plan.md').includes('- [ ] wire the tool'));
  assert.ok(read('implementation_plan.md').startsWith('# item one'), 'the plan still describes the same item');
});

test('the plan moves while the item is still in flight', async () => {
  seed();
  const before = read('task.md');

  const ticked = JSON.parse(await updateTaskExecute({ action: 'step', stepIndex: 3, intent: 'tick the third step' }));
  assert.equal(ticked.status, 'success');
  assert.equal(ticked.planProgress.done, 1);
  assert.equal(read('task.md'), before, 'the task list is untouched until the item itself is completed');
});

test('ticking the last step marks the plan status done', async () => {
  seed({ plan: '# item one\n\nstatus: in progress\n\n## Steps\n\n- [x] a\n- [x] b\n- [ ] c\n' });

  const last = JSON.parse(await updateTaskExecute({ action: 'step', step: 'c', intent: 'tick the last step' }));
  assert.equal(last.planProgress.pending, 0);
  // `done` is one of the three canonical states (utils/tracking-format.js).
  assert.equal(last.planStatus, 'done');
  assert.ok(read('implementation_plan.md').includes('status: done'));
});

test('ticking a step refuses an unknown, ambiguous or already-ticked step', async () => {
  seed({ plan: '# item one\n\nstatus: in progress\n\n## Steps\n\n- [x] write the module\n- [ ] wire the tool\n- [ ] wire the tests\n' });
  const before = read('implementation_plan.md');

  const unknown = JSON.parse(await updateTaskExecute({ action: 'step', step: 'nothing like this', intent: 'x' }));
  assert.equal(unknown.code, 'STEP_NOT_FOUND');
  assert.equal(unknown.steps.length, 3, 'the refusal lists the real steps');

  const ambiguous = JSON.parse(await updateTaskExecute({ action: 'step', step: 'wire', intent: 'x' }));
  assert.equal(ambiguous.code, 'STEP_NOT_FOUND');

  const already = JSON.parse(await updateTaskExecute({ action: 'step', step: 'write the module', intent: 'x' }));
  assert.equal(already.status, 'skipped');
  assert.equal(already.code, 'ALREADY_DONE');

  assert.equal(read('implementation_plan.md'), before, 'no refusal ever writes the plan');
});

test('a missing plan file is reported instead of created', async () => {
  writeFile('task.md', '- [ ] item one\n');
  if (fs.existsSync('implementation_plan.md')) fs.unlinkSync('implementation_plan.md');

  const result = JSON.parse(await updateTaskExecute({ action: 'step', step: 'anything', intent: 'x' }));
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'PLAN_FILE_NOT_FOUND');
  assert.equal(fs.existsSync('implementation_plan.md'), false);
});

test('update_task list reports the plan progress', async () => {
  seed({ plan: '# item one\n\nstatus: in progress\n\n## Steps\n\n- [x] a\n- [ ] b\n' });

  const listed = JSON.parse(await updateTaskExecute({ action: 'list', intent: 'see progress' }));
  assert.equal(listed.status, 'ok');
  assert.deepEqual(listed.planProgress, { total: 2, done: 1, pending: 1 });
  assert.equal(listed.next, 'item one');
  assert.equal(listed.items.length, 2);
});

test('an unknown action is still refused, and renderPlan stays exported here', async () => {
  seed();
  const bad = JSON.parse(await updateTaskExecute({ action: 'tick', intent: 'x' }));
  assert.equal(bad.code, 'INVALID_ACTION');

  const plan = renderPlan({ item: { text: 'item two' }, status: 'in progress', steps: ['one'] });
  assert.ok(plan.startsWith('# item two'));
  assert.ok(plan.includes('- [ ] one'));
});

test('completing an item still moves the plan on to the next one', async () => {
  seed();

  const done = JSON.parse(await updateTaskExecute({
    action: 'complete',
    item: 'item one',
    steps: ['first step of two'],
    intent: 'finish item one'
  }));

  assert.equal(done.status, 'success');
  assert.equal(done.next, 'item two');
  assert.ok(read('task.md').includes('- [x] item one'));
  assert.ok(read('implementation_plan.md').startsWith('# item two'), 'the plan is reset for the next item');
  assert.deepEqual(parsePlanSteps(read('implementation_plan.md')).map((s) => s.text), ['first step of two']);
  assert.equal(parseTaskItems(read('task.md')).filter((item) => item.done).length, 1);
});
