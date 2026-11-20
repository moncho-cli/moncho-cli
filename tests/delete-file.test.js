import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execute as deleteExecute } from '../tools/delete_file.js';
import { deleteFileVerified } from '../utils/file-io.js';
import { TOOL_OWNED_FILES } from '../utils/tracking-fence.js';

/**
 * Proof for `delete_file` (task-backlog: "add a delete_file tool, that can only delete
 * files within the workdir, never out of it").
 *
 * The interesting half of a delete tool is what it *refuses*: removing a file cannot be
 * undone by retrying the call, so the sandbox, the directory check and the tracking
 * fence are each proven here next to the happy path.
 *
 * The suite runs inside a throwaway directory (`process.chdir`), because every file tool
 * resolves through `resolveProjectPath()`, which reads `process.cwd()`.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-delete-test-'));
const outsideFile = path.join(path.dirname(root), `moncho-delete-outside-${process.pid}.txt`);
process.chdir(root);

function writeFile(name, content = 'body\n') {
  fs.mkdirSync(path.dirname(name), { recursive: true });
  fs.writeFileSync(name, content, 'utf-8');
}

writeFile('app/alpha.js', 'export const alpha = 1;\n');
writeFile('notes.md', 'a note\n');
writeFile('task.md', '# Task list\n\n- [ ] one\n');
writeFile('agent/sessions/s1/implementation_plan.md', '# plan\n');
fs.mkdirSync('empty-dir', { recursive: true });
fs.writeFileSync(outsideFile, 'not ours\n', 'utf-8');

const parsed = (result) => JSON.parse(result);

test('delete_file removes one project file and reports verified success', async () => {
  const result = parsed(await deleteExecute({ path: 'notes.md', intent: 'drop a scratch note' }));

  assert.equal(result.status, 'success');
  assert.equal(result.path, 'notes.md');
  assert.equal(result.deleted, true);
  assert.equal(result.verified, true);
  assert.equal(result.bytes, 'a note\n'.length);
  assert.ok(result.message.includes('notes.md'));
  // The proof is the disk, not the report.
  assert.equal(fs.existsSync(path.join(root, 'notes.md')), false);
  // Its neighbours are untouched: this removes one file, never a folder.
  assert.equal(fs.existsSync(path.join(root, 'app/alpha.js')), true);
});

test('delete_file refuses a path that walks out of the project', async () => {
  // A sibling of the project root: the sandbox, not the tool, decides reachability.
  const escapes = [
    `../${path.basename(outsideFile)}`,
    `app/../../${path.basename(outsideFile)}`,
    outsideFile,
    './',
  ];

  for (const attempt of escapes) {
    const result = parsed(await deleteExecute({ path: attempt, intent: 'escape attempt' }));
    assert.equal(result.status, 'error', JSON.stringify(attempt));
    assert.equal(result.code, 'INVALID_PATH', JSON.stringify(attempt));
    assert.ok(result.guidance.includes('relative path'), JSON.stringify(attempt));
  }
  assert.equal(fs.existsSync(outsideFile), true, 'nothing outside the project was touched');
  assert.equal(fs.existsSync(path.join(root, 'app/alpha.js')), true, 'nothing inside was touched either');
});

test('delete_file refuses a blank path as a malformed call, not as an escape', async () => {
  // A blank path never reaches the sandbox: it is refused as an argument first, and it
  // gets its own code because the caller's fix is a different one.
  for (const blank of ['', '   ', undefined]) {
    const result = parsed(await deleteExecute({ path: blank, intent: 'no path' }));
    assert.equal(result.code, 'INVALID_ARGUMENTS', JSON.stringify(blank));
  }
});

test('delete_file refuses a directory and reports a missing path instead of succeeding', async () => {
  const directory = parsed(await deleteExecute({ path: 'empty-dir', intent: 'try a folder' }));
  assert.equal(directory.status, 'error');
  assert.equal(directory.code, 'IS_DIRECTORY');
  assert.ok(directory.guidance.includes('one file'));
  assert.equal(fs.existsSync(path.join(root, 'empty-dir')), true, 'the folder survives');

  const missing = parsed(await deleteExecute({ path: 'app/never-there.js', intent: 'expect a miss' }));
  assert.equal(missing.code, 'NOT_FOUND');
  assert.equal(missing.path, 'app/never-there.js');
  assert.ok(missing.guidance.includes('read_file'), 'the model is told how to check first');

  const unnamed = parsed(await deleteExecute({ intent: 'no path at all' }));
  assert.equal(unnamed.code, 'INVALID_ARGUMENTS');
});

test('delete_file never removes a tracking file, whichever folder holds it', async () => {
  for (const target of ['task.md', 'agent/sessions/s1/implementation_plan.md']) {
    const result = parsed(await deleteExecute({ path: target, intent: 'drop the checklist' }));
    assert.equal(result.status, 'error', target);
    assert.equal(result.code, 'TRACKING_FILE_TOOL_OWNED', target);
    assert.ok(result.message.includes('update_task'), target);
    assert.ok(result.guidance.includes('update_task'), `${target} names the owning tool`);
    assert.equal(fs.existsSync(path.join(root, target)), true, `${target} is still there`);
  }
  assert.deepEqual(TOOL_OWNED_FILES, ['task.md', 'implementation_plan.md']);
});

test('deleteFileVerified() reports the removal it can prove and refuses the rest', () => {
  writeFile('scratch/one.txt', 'one\n');
  const gone = deleteFileVerified('scratch/one.txt');
  assert.deepEqual(gone, { path: 'scratch/one.txt', bytes: 4, deleted: true, verified: true });
  assert.equal(fs.existsSync(path.join(root, 'scratch/one.txt')), false);

  // A second call is NOT_FOUND rather than a silent second success: the removal is
  // idempotent on disk but never in the report, because the caller has to know.
  assert.throws(() => deleteFileVerified('scratch/one.txt'), (error) => error.code === 'NOT_FOUND');
  assert.throws(() => deleteFileVerified('empty-dir'), (error) => error.code === 'IS_DIRECTORY');
  assert.throws(() => deleteFileVerified(outsideFile), (error) => error.code === 'INVALID_PATH');
});

test('a symlink is unlinked without touching its target', () => {
  writeFile('real/target.txt', 'keep me\n');
  fs.symlinkSync(path.join(root, 'real/target.txt'), path.join(root, 'link.txt'));

  const result = deleteFileVerified('link.txt');
  assert.equal(result.deleted, true);
  assert.equal(fs.existsSync(path.join(root, 'link.txt')), false, 'the link is gone');
  assert.equal(fs.readFileSync(path.join(root, 'real/target.txt'), 'utf-8'), 'keep me\n');
});

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outsideFile, { force: true });
});
