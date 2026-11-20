import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  TOOL_OWNED_FILES, TRACKING_TOOL, TRACKING_FILE_REFUSAL, TRACKING_LOCATION_REFUSAL,
  isToolOwnedFile, isSessionTrackingPath, toolOwnedKind, canonicalTrackingWrite,
  trackingFenceRefusal, trackingLocationRefusal,
} from '../utils/tracking-fence.js';
import { validateTrackingFile } from '../utils/tracking-format.js';
import { execute as writeFileExecute } from '../tools/write_file.js';
import { execute as editFileExecute } from '../tools/edit_file.js';

/**
 * The fence around the two tracking files.
 *
 * They have a fixed shape and one owner (`update_task`), so the generic writers stay out
 * of the way in the two different ways the two operations deserve: `write_file` accepts
 * a draft and stores the canonical document, and both editing shapes of `edit_file`
 * refuse outright because a region change into a re-rendered file would be undone by the
 * next tracking call.
 *
 * The pair also has a **place**: a session folder. `write_file` is the one writer that
 * could create one anywhere, so a tracking name is accepted only under
 * `agent/sessions/<id>/` and the project root is refused — the rule that keeps the
 * harness from leaving a `task.md` in the tree at all.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-fence-test-'));
process.chdir(root);

const SESSION = 'agent/sessions/s1';
const read = (name) => fs.readFileSync(name, 'utf-8');

function writeFile(name, content) {
  fs.mkdirSync(path.dirname(name), { recursive: true });
  fs.writeFileSync(name, content, 'utf-8');
}

test('the fence recognises a tracking file by name, in any folder', () => {
  assert.deepEqual([...TOOL_OWNED_FILES], ['task.md', 'implementation_plan.md']);

  for (const path of [
    'task.md', './task.md', 'agent/sessions/x/task.md', '/task.md', 'a\\b\\task.md',
  ]) {
    assert.equal(isToolOwnedFile(path), true, path);
  }
  assert.equal(isToolOwnedFile('implementation_plan.md'), true);

  for (const path of ['', '  ', 'app/tui.js', 'task.md.bak', 'notes/task.md.txt', null]) {
    assert.equal(isToolOwnedFile(path), false, JSON.stringify(path));
  }

  assert.equal(toolOwnedKind('a/task.md'), 'task');
  assert.equal(toolOwnedKind('implementation_plan.md'), 'plan');
  assert.equal(toolOwnedKind('app/main.js'), null);
});

test('a tracking file lives one session folder deep, and nowhere else', () => {
  for (const path of [
    'agent/sessions/s1/task.md',
    './agent/sessions/2026-02-14T10-30-00-000Z/implementation_plan.md',
  ]) {
    assert.equal(isSessionTrackingPath(path), true, path);
    assert.equal(trackingLocationRefusal(path), null, path);
  }

  // `.` is dropped, and nothing else is tidied: a path that walks around with `..` is
  // refused rather than guessed at, so the rule fails closed where a write could land
  // somewhere the caller did not name.
  for (const path of [
    'task.md',
    './task.md',
    'implementation_plan.md',
    'notes/task.md',
    'agent/sessions/task.md',
    'agent/sessions/s1/deeper/task.md',
    'agent/sessions/s1/notes.md',
    'agent/sessions/s1/../s1/task.md',
    'app/tui.js',
  ]) {
    assert.equal(isSessionTrackingPath(path), false, path);
  }

  // The root is refused with its own code, and it names the tool that can write the pair.
  // The wording names no folder: where the pair lives is the harness's business, and
  // `update_task` reports the resolved paths in every reply.
  const rootRefusal = trackingLocationRefusal('task.md');
  assert.equal(rootRefusal.code, TRACKING_LOCATION_REFUSAL);
  assert.doesNotMatch(rootRefusal.message, /agent\/sessions|session folder/);
  assert.doesNotMatch(rootRefusal.guidance, /agent\/sessions|session folder/);
  assert.match(rootRefusal.guidance, new RegExp(TRACKING_TOOL));
  assert.equal(trackingLocationRefusal('app/tui.js'), null, 'an ordinary path is not tracking');
});

test('a write_file draft is normalised instead of stored verbatim', () => {
  const draft = '- [x] one\n- [ ] two\nstatus: in progress: two\n';
  const normalised = canonicalTrackingWrite('task.md', draft);

  assert.equal(normalised.kind, 'task');
  const checked = validateTrackingFile(normalised.content, { kind: 'task' });
  assert.equal(checked.ok, true, checked.problems.join('; '));
  assert.equal(checked.items.length, 2);

  // A non-tracking path is the caller's business: nothing is rewritten.
  assert.equal(canonicalTrackingWrite('app/main.js', 'const x = 1;\n'), null);
});

test('write_file stores the canonical document when it is handed a checklist', async () => {
  const result = JSON.parse(await writeFileExecute({
    path: `${SESSION}/task.md`,
    content: '- [ ] one\n- [ ] two\n',
    intent: 'draft the checklist',
  }));

  assert.equal(result.status, 'success');
  assert.equal(result.canonicalised, true);
  assert.equal(result.kind, 'task');
  assert.match(result.message, /canonical shape/);

  const stored = read(`${SESSION}/task.md`);
  assert.ok(stored.startsWith('# Task list\n'), 'the title is added');
  assert.ok(stored.includes('status: pending'), 'the status line is added');
  assert.equal(validateTrackingFile(stored, { kind: 'task' }).items.length, 2, 'no entry is lost');
});

test('write_file refuses to create a tracking file at the project root', async () => {
  const refused = JSON.parse(await writeFileExecute({
    path: 'task.md',
    content: '- [ ] one\n',
    intent: 'draft a root checklist',
  }));

  assert.equal(refused.status, 'error');
  assert.equal(refused.code, TRACKING_LOCATION_REFUSAL);
  assert.match(refused.guidance, new RegExp(TRACKING_TOOL));
  assert.equal(fs.existsSync(path.join(root, 'task.md')), false, 'nothing was created');

  // The plan is the other half of the same pair, so it answers the same way.
  const plan = JSON.parse(await writeFileExecute({
    path: 'implementation_plan.md',
    content: '- [ ] a step\n',
    intent: 'draft a root plan',
  }));
  assert.equal(plan.code, TRACKING_LOCATION_REFUSAL);
  assert.equal(fs.existsSync(path.join(root, 'implementation_plan.md')), false);
});

test('write_file leaves an ordinary file byte-for-byte alone', async () => {
  const result = JSON.parse(await writeFileExecute({
    path: 'notes.txt',
    content: 'raw text\n',
    intent: 'write a scratch note',
  }));

  assert.equal(result.status, 'success');
  assert.equal(result.canonicalised, undefined, 'ordinary files are not announced as canonical');
  assert.equal(read('notes.txt'), 'raw text\n');
});

test('a pasted diff into a tracking file is refused, and names the tool to use', async () => {
  writeFile(`${SESSION}/implementation_plan.md`, '# Plan\n\nstatus: pending\n\n## Steps\n\n- [ ] a\n');
  const before = read(`${SESSION}/implementation_plan.md`);

  const patch = [
    `--- a/${SESSION}/implementation_plan.md`,
    `+++ b/${SESSION}/implementation_plan.md`,
    '@@ -1,5 +1,5 @@',
    ' # Plan',
    ' ',
    ' status: pending',
    ' ',
    ' ## Steps',
  ].join('\n');

  const refused = JSON.parse(await editFileExecute({
    path: `${SESSION}/implementation_plan.md`,
    patchStr: patch,
    intent: 'edit the plan by hand',
  }));

  assert.equal(refused.status, 'error');
  assert.equal(refused.code, TRACKING_FILE_REFUSAL);
  assert.match(refused.message, /rewritten whole/);
  assert.match(refused.guidance, new RegExp(TRACKING_TOOL), 'the model is told what to call');
  assert.equal(read(`${SESSION}/implementation_plan.md`), before, 'the fence never touches the file');
});

test('a stray root copy of a tracking file is refused too, and never created', () => {
  // The name is enough for the *editing* writers: a copy that should not exist is still a
  // document a region change must not touch.
  assert.equal(trackingFenceRefusal('task.md').code, TRACKING_FILE_REFUSAL);
  assert.equal(trackingFenceRefusal(`${SESSION}/task.md`).code, TRACKING_FILE_REFUSAL);
});

test('the same diff still patches an ordinary file', async () => {
  writeFile('code.js', 'a\nb\n');
  const patched = JSON.parse(await editFileExecute({
    path: 'code.js',
    patchStr: '--- a/code.js\n+++ b/code.js\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n',
    intent: 'change the fixture',
  }));

  assert.equal(patched.status, 'success');
  assert.equal(read('code.js'), 'a\nB\n');
  assert.equal(trackingFenceRefusal('code.js'), null);
});

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});