import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  normalizeTrackingKind, invalidFileRefusal, authorTrackingDraft, editTrackingDraft,
  refusal, TRACKING_KINDS, DEFAULT_TRACKING_KIND,
} from '../utils/tracking-draft.js';
import { execute as writePlanExecute } from '../tools/write_plan_md.js';
import { execute as editPlanExecute } from '../tools/edit_plan_md.js';
import { definition as writePlanDefinition } from '../tools/write_plan_md.js';
import { definition as editPlanDefinition } from '../tools/edit_plan_md.js';
import { registerSession, clearSession } from '../utils/host.js';
import { trackingPaths, readPlanContent, readTaskContent } from '../utils/tracking-store.js';
import { validateTrackingFile } from '../utils/tracking-format.js';
import { hasIntentParameter } from '../utils/tool-schema.js';

/**
 * The `design` mode's own writers (`docs/interface/modes`).
 *
 * A design session authors exactly two documents — its checklist and its plan — and it does
 * it through `write_plan_md` / `edit_plan_md` rather than the generic `write_file` /
 * `edit_file`. The whole value is the argument the two tools do **not** have: no `path`.
 * The scope is therefore a property of the tool rather than a check it performs, so these
 * cases prove both halves — that the pair is written where the session lives, and that
 * there is no argument through which anything else could be reached.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-design-writers-'));
process.chdir(root);

const ID = '2026-03-01T09-00-00-000Z';
const FOLDER = `agent/sessions/${ID}`;

/** Run one tool with parsed arguments, as the loader does. */
const run = (execute, args) => execute(args).then((raw) => JSON.parse(raw));

const register = () => registerSession({ id: ID }, null, null);

test('normalizeTrackingKind names the two documents, or answers null', () => {
  // Both spellings a person uses: the kind and the file itself.
  for (const value of ['task', 'task.md', 'TASK', 'Task.md']) {
    assert.equal(normalizeTrackingKind(value), 'task', value);
  }
  for (const value of ['plan', 'implementation_plan.md', 'PLAN']) {
    assert.equal(normalizeTrackingKind(value), 'plan', value);
  }
  // Nothing named means the plan: the document design is for.
  assert.equal(normalizeTrackingKind(undefined), DEFAULT_TRACKING_KIND);
  assert.equal(normalizeTrackingKind(''), DEFAULT_TRACKING_KIND);
  assert.equal(DEFAULT_TRACKING_KIND, 'plan');
  assert.deepEqual(TRACKING_KINDS, { task: 'task.md', plan: 'implementation_plan.md' });
  // A typo is never guessed into the wrong document.
  for (const bad of ['notes', 'app/tui.js', 'plan.md', 42]) {
    assert.equal(normalizeTrackingKind(bad), null, String(bad));
  }
});

test('neither design writer takes a path, so there is nothing to point elsewhere', () => {
  // The whole guarantee is the missing argument: a tool that cannot name a file cannot
  // name the wrong one, and a mode policy has no path to police.
  for (const definition of [writePlanDefinition, editPlanDefinition]) {
    const properties = definition.function.parameters.properties;
    assert.equal(properties.path, undefined, `${definition.function.name} must take no path`);
    assert.ok(properties.file, 'the call names which document it means');
    assert.deepEqual(properties.file.enum, ['task', 'plan']);
    assert.ok(hasIntentParameter(definition));
  }
  // `write_plan_md` needs content (and the contract's own `intent`, prepended by
  // `withIntentParameter`); `edit_plan_md` validates its edit shape at run time instead.
  assert.deepEqual(writePlanDefinition.function.parameters.required, ['intent', 'content']);
});

test('write_plan_md authors the session pair, and only there', async () => {
  register();

  const result = await run(writePlanExecute, {
    file: 'plan',
    content: '# item one\n\n## Steps\n\n- [ ] do the thing\n',
  });
  assert.equal(result.status, 'success');
  assert.equal(result.file, 'plan');
  assert.equal(result.path, `${FOLDER}/implementation_plan.md`);
  assert.equal(result.canonicalised, true);
  assert.equal(result.valid, true);

  // The document landed where the session lives, in the canonical shape.
  const onDisk = fs.readFileSync(`${FOLDER}/implementation_plan.md`, 'utf-8');
  assert.equal(onDisk, readPlanContent());
  assert.equal(validateTrackingFile(onDisk, { kind: 'plan' }).ok, true);
  assert.match(onDisk, /^# item one\n\nstatus: pending\n\n## Steps\n/);
  assert.match(onDisk, /- \[ \] do the thing/);

  // The checklist is a different document, and it is written by the same tool.
  const task = await run(writePlanExecute, {
    file: 'task',
    content: '# Task list\n\n## Items\n\n- [ ] one\n- [ ] two\n',
  });
  assert.equal(task.path, `${FOLDER}/task.md`);
  assert.match(readTaskContent(), /- \[ \] two/);
  // Authoring one document never touches the other.
  assert.match(readPlanContent(), /do the thing/);

  clearSession();
});

test('a draft is re-rendered, so a design session cannot leave a malformed document', async () => {
  register();

  // A bare list, no title, no status, no heading: exactly what a model drafts.
  const result = await run(writePlanExecute, {
    file: 'task',
    content: '- [ ] first\n- [x] second\n',
  });
  assert.equal(result.canonicalised, true);

  const onDisk = readTaskContent();
  const report = validateTrackingFile(onDisk, { kind: 'task' });
  assert.equal(report.ok, true, `the stored document is canonical: ${report.problems.join('; ')}`);
  assert.match(onDisk, /^# Task list/);
  assert.match(onDisk, /status: pending/);
  assert.match(onDisk, /## Items/);
  // The items survived the re-render, with their done flags.
  assert.deepEqual(report.items.map((item) => ({ done: item.done, text: item.text })), [
    { done: false, text: 'first' },
    { done: true, text: 'second' },
  ]);

  clearSession();
});

test('edit_plan_md changes the document by literal search, and re-canonicalises it', async () => {
  register();
  await run(writePlanExecute, { file: 'plan', content: '# item one\n\n## Steps\n\n- [ ] do the thing\n' });

  const result = await run(editPlanExecute, {
    file: 'plan',
    search: '- [ ] do the thing',
    replace: '- [x] do the thing\n- [ ] then the next',
  });
  assert.equal(result.status, 'success');
  assert.equal(result.replacements, 1);
  assert.equal(result.path, `${FOLDER}/implementation_plan.md`);

  const onDisk = readPlanContent();
  assert.match(onDisk, /- \[x\] do the thing/);
  assert.match(onDisk, /- \[ \] then the next/);
  // The edit cannot leave a dialect behind: the result is re-rendered.
  assert.equal(validateTrackingFile(onDisk, { kind: 'plan' }).ok, true);

  // An edit that breaks the shape is repaired rather than stored: dropping the title is
  // undone by the re-render, because the canonical document always keeps one (the plan
  // falls back to its default title when the item it was named for is gone).
  await run(editPlanExecute, { file: 'plan', search: '# item one\n\n', replace: '' });
  const repaired = readPlanContent();
  assert.match(repaired, /^# /, 'the re-render restores a title');
  assert.equal(validateTrackingFile(repaired, { kind: 'plan' }).ok, true);

  clearSession();
});

test('edit_plan_md reports a miss with the same diagnostics as edit_file', async () => {
  register();
  await run(writePlanExecute, { file: 'plan', content: '# item one\n\n## Steps\n\n- [ ] do the thing\n- [ ] do the thing\n' });

  const missing = await run(editPlanExecute, { file: 'plan', search: 'not in the document', replace: 'x' });
  assert.equal(missing.status, 'error');
  assert.equal(missing.code, 'SEARCH_NOT_FOUND');
  // The bytes on disk come back, so the next call is built from what is really there.
  assert.ok(Array.isArray(missing.source) || typeof missing.source === 'string');
  assert.ok(missing.retry);

  // The document is untouched by a refused edit.
  assert.match(readPlanContent(), /- \[ \] do the thing/);

  // An ambiguous search is refused, not guessed.
  const ambiguous = await run(editPlanExecute, { file: 'plan', search: '- [ ]', replace: '- [x]' });
  assert.equal(ambiguous.code, 'SEARCH_NOT_UNIQUE');

  // And the shapes are not mixed: one call carries either "edits" or a pair.
  const mixed = await run(editPlanExecute, {
    file: 'plan', search: 'a', replace: 'b', edits: [{ search: 'a', replace: 'b' }],
  });
  assert.equal(mixed.code, 'INVALID_ARGUMENTS');

  const empty = await run(editPlanExecute, { file: 'plan' });
  assert.equal(empty.code, 'INVALID_ARGUMENTS');

  clearSession();
});

test('without a session there is no pair to write, so the call is refused', async () => {
  clearSession();

  // The store answers no paths at all, and both tools refuse rather than reach the root.
  const paths = trackingPaths();
  assert.deepEqual(paths, { task: null, plan: null, folder: null });

  for (const result of [
    await run(writePlanExecute, { file: 'plan', content: '- [ ] x\n' }),
    await run(editPlanExecute, { file: 'plan', search: 'x', replace: 'y' }),
  ]) {
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'NO_SESSION');
    assert.match(result.message, /agent\/sessions/);
  }

  // And nothing was created at the root: the pair belongs to a conversation.
  assert.equal(fs.existsSync('task.md'), false);
  assert.equal(fs.existsSync('implementation_plan.md'), false);
});

test('a file argument that names neither document is refused, never guessed', async () => {
  register();

  const invalid = await run(writePlanExecute, { file: 'notes.md', content: '- [ ] x\n' });
  assert.equal(invalid.code, 'INVALID_FILE');
  assert.match(invalid.guidance, /"task" or "file": "plan"|"file": "plan"/);

  const editing = await run(editPlanExecute, { file: 'app/tui.js', search: 'a', replace: 'b' });
  assert.equal(editing.code, 'INVALID_FILE');

  // The refusal is the helper's own value, and it names both documents so the model can
  // correct itself instead of guessing again.
  const direct = JSON.parse(invalidFileRefusal('nope'));
  assert.equal(direct.code, 'INVALID_FILE');
  assert.deepEqual(direct.files, { task: 'task.md', plan: 'implementation_plan.md' });
  assert.equal(refusal('X', 'm').includes('"code":"X"'), true);

  // A document the session has not authored yet is reported, never created: authoring is
  // `write_plan_md`'s job.
  fs.rmSync(`${FOLDER}/implementation_plan.md`, { force: true });
  const noPlan = await run(editPlanExecute, { file: 'plan', search: 'x', replace: 'y' });
  assert.equal(noPlan.code, 'FILE_NOT_FOUND');
  assert.equal(fs.existsSync(`${FOLDER}/implementation_plan.md`), false, 'a refused edit creates nothing');

  clearSession();
});

test('authorTrackingDraft and editTrackingDraft are the pure halves both tools call', () => {
  // A non-string content is a caller error, not a write.
  const bad = JSON.parse(authorTrackingDraft({ kind: 'plan', content: 42 }));
  assert.equal(bad.code, 'INVALID_CONTENT');
  // A blank kind never reaches a file: with no session it is refused first.
  clearSession();
  assert.equal(JSON.parse(authorTrackingDraft({ kind: 'task', content: '' })).code, 'NO_SESSION');
  assert.equal(JSON.parse(editTrackingDraft({ kind: 'task', edits: [] })).code, 'NO_SESSION');
});
