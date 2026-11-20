import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  TOOL_OWNED_FILES, TRACKING_TOOL, TRACKING_FILE_REFUSAL,
  isToolOwnedFile, toolOwnedKind, canonicalTrackingWrite, trackingFenceRefusal,
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
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-fence-test-'));
process.chdir(root);

const read = (name) => fs.readFileSync(name, 'utf-8');


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
    path: 'task.md',
    content: '- [ ] one\n- [ ] two\n',
    intent: 'draft the checklist',
  }));

  assert.equal(result.status, 'success');
  assert.equal(result.canonicalised, true);
  assert.equal(result.kind, 'task');
  assert.match(result.message, /canonical shape/);

  const stored = read('task.md');
  assert.ok(stored.startsWith('# Task list\n'), 'the title is added');
  assert.ok(stored.includes('status: pending'), 'the status line is added');
  assert.equal(validateTrackingFile(stored, { kind: 'task' }).items.length, 2, 'no entry is lost');
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
  fs.writeFileSync('implementation_plan.md', '# Plan\n\nstatus: pending\n\n## Steps\n\n- [ ] a\n', 'utf-8');
  const before = read('implementation_plan.md');

  const patch = [
    '--- a/implementation_plan.md',
    '+++ b/implementation_plan.md',
    '@@ -1,5 +1,5 @@',
    ' # Plan',
    ' ',
    ' status: pending',
    ' ',
    ' ## Steps',
  ].join('\n');

  const refused = JSON.parse(await editFileExecute({
    path: 'implementation_plan.md',
    patchStr: patch,
    intent: 'edit the plan by hand',
  }));

  assert.equal(refused.status, 'error');
  assert.equal(refused.code, TRACKING_FILE_REFUSAL);
  assert.match(refused.message, /rewritten whole/);
  assert.match(refused.guidance, new RegExp(TRACKING_TOOL), 'the model is told what to call');
  assert.equal(read('implementation_plan.md'), before, 'the fence never touches the file');
});

test('the same diff still patches an ordinary file', async () => {
  fs.writeFileSync('code.js', 'a\nb\n', 'utf-8');
  const patched = JSON.parse(await editFileExecute({
    path: 'code.js',
    patchStr: '--- a/code.js\n+++ b/code.js\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n',
    intent: 'change the fixture',
  }));

  assert.equal(patched.status, 'success');
  assert.equal(read('code.js'), 'a\nB\n');
  assert.equal(trackingFenceRefusal('code.js'), null);
});