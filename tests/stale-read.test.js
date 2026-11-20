import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  clearReads,
  fingerprint,
  forgetRead,
  readDrift,
  recordRead,
  staleWriteRefusal,
  trackedReads,
} from '../utils/read-tracker.js';
import { execute as readFileExecute } from '../tools/read_file.js';
import { execute as hintFileExecute } from '../tools/hint_file.js';
import { execute as writeFileExecute } from '../tools/write_file.js';
import { execute as editFileExecute } from '../tools/edit_file.js';
import { execute as deleteFileExecute } from '../tools/delete_file.js';
import { execute as blobExecute } from '../tools/blob.js';

/**
 * The stale-read guard: what the model has read is remembered, and a write into a file
 * that changed since is refused with `STALE_READ` until the model re-reads.
 *
 * The backlog entry asks for exactly this ("if the model tries to write and the file has
 * been touched / edit time has changed, refuse to write / patch and ask the model to
 * call read first"). The cases below drive the real tools, so they prove the wiring and
 * the refusal, never a mock of it.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-stale-read-'));
process.chdir(root);

const write = (name, content) => {
  fs.mkdirSync(path.dirname(name), { recursive: true });
  fs.writeFileSync(name, content, 'utf-8');
};
const read = (name) => fs.readFileSync(name, 'utf-8');
const parsed = (result) => JSON.parse(result);

test('recordRead()/readDrift() remember the bytes a read handed over', () => {
  clearReads();
  write('fingerprint.txt', 'one\ntwo\n');

  assert.equal(trackedReads().size, 0, 'nothing is tracked before a read');
  const entry = recordRead('fingerprint.txt');
  assert.equal(entry.path, 'fingerprint.txt');
  assert.equal(entry.size, read('fingerprint.txt').length);

  // The same bytes: the model's view is still the file on disk.
  const quiet = readDrift('fingerprint.txt');
  assert.equal(quiet.tracked, true);
  assert.equal(quiet.stale, false);
  assert.equal(quiet.reason, null);
  assert.equal(staleWriteRefusal('fingerprint.txt'), null, 'an unchanged file is written');

  // Someone else changed it.
  write('fingerprint.txt', 'one\ntwo\nthree\n');
  const drift = readDrift('fingerprint.txt');
  assert.equal(drift.stale, true);
  assert.equal(drift.reason, 'modified');
  assert.equal(drift.recorded.size, 'one\ntwo\n'.length);
  assert.equal(drift.current.size, 'one\ntwo\nthree\n'.length);

  // A file the model never read is not tracked, and neither is a path it cannot name.
  assert.equal(readDrift('never-read.txt').tracked, false);
  assert.equal(readDrift('../escape.txt').tracked, false);
  assert.equal(fingerprint('missing.txt'), null);
  assert.equal(recordRead('missing.txt'), null, 'there is nothing to remember about a missing file');
});

test('a write into a file that changed since the read is refused with STALE_READ', async () => {
  clearReads();
  write('report.txt', 'first draft\n');
  await readFileExecute({ path: 'report.txt', intent: 'read the draft' });

  // The user edits the file while the model is thinking.
  write('report.txt', 'the user rewrote this\n');

  const refused = parsed(await writeFileExecute({
    path: 'report.txt',
    content: 'the model overwrites it\n',
    intent: 'overwrite what I read',
  }));

  assert.equal(refused.status, 'error');
  assert.equal(refused.code, 'STALE_READ');
  assert.equal(refused.path, 'report.txt');
  assert.equal(refused.reason, 'modified');
  assert.equal(refused.recordedBytes, 'first draft\n'.length);
  assert.equal(refused.currentBytes, 'the user rewrote this\n'.length);
  assert.match(refused.message, /changed on disk after you read it/);
  assert.match(refused.message, /Nothing was changed/);
  assert.match(refused.guidance, /read_file/, 'the model is told which tool to call');
  assert.equal(read('report.txt'), 'the user rewrote this\n', 'the user edit survives');
});

test('re-reading clears the refusal, and the write then lands', async () => {
  clearReads();
  write('recover.txt', 'v1\n');
  await readFileExecute({ path: 'recover.txt', intent: 'read v1' });
  write('recover.txt', 'v2 by the user\n');

  assert.equal(parsed(await writeFileExecute({ path: 'recover.txt', content: 'x\n', intent: 'too early' })).code, 'STALE_READ');

  await readFileExecute({ path: 'recover.txt', lineNumbers: false, intent: 'learn what changed' });
  const ok = parsed(await writeFileExecute({ path: 'recover.txt', content: 'v3 by the model\n', intent: 'write now' }));

  assert.equal(ok.status, 'success');
  assert.equal(read('recover.txt'), 'v3 by the model\n');
  assert.equal(trackedReads().has('recover.txt'), false, 'a successful write forgets the recorded read');
});

test('a successful write leaves no stale view behind, so the next write is not refused', async () => {
  clearReads();
  write('twice.txt', 'a\n');
  await readFileExecute({ path: 'twice.txt', intent: 'read the fixture' });

  const first = parsed(await writeFileExecute({ path: 'twice.txt', content: 'b\n', intent: 'first write' }));
  const second = parsed(await writeFileExecute({ path: 'twice.txt', content: 'c\n', intent: 'second write' }));

  assert.equal(first.status, 'success');
  assert.equal(second.status, 'success', 'the model owns the bytes it just wrote');
  assert.equal(read('twice.txt'), 'c\n');
});

test('a pasted diff is refused on a stale target before it matches a single hunk', async () => {
  clearReads();
  write('patchable.txt', 'a\nb\n');
  await readFileExecute({ path: 'patchable.txt', lineNumbers: false, intent: 'read before patching' });
  write('patchable.txt', 'a\nB\n');

  const refused = parsed(await editFileExecute({
    path: 'patchable.txt',
    patchStr: '--- a/patchable.txt\n+++ b/patchable.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+Z\n',
    intent: 'patch what I read',
  }));

  assert.equal(refused.status, 'error');
  assert.equal(refused.code, 'STALE_READ', 'the guard answers before the hunk matcher could');
  assert.match(refused.guidance, /read_file/);
  assert.equal(read('patchable.txt'), 'a\nB\n', 'the user edit survives');

  // Re-reading and retrying the patch is what clears it.
  await readFileExecute({ path: 'patchable.txt', lineNumbers: false, intent: 'learn the new bytes' });
  const ok = parsed(await editFileExecute({
    path: 'patchable.txt',
    patchStr: '--- a/patchable.txt\n+++ b/patchable.txt\n@@ -1,2 +1,2 @@\n a\n-B\n+Z\n',
    intent: 'patch the bytes I just read',
  }));
  assert.equal(ok.status, 'success');
  assert.equal(read('patchable.txt'), 'a\nZ\n');
});

test('a file the model never read, and a brand-new file, are written as before', async () => {
  clearReads();
  write('untouched.txt', 'on disk\n');

  // No read was recorded for it, so there is no stale view to protect.
  const overwrite = parsed(await writeFileExecute({ path: 'untouched.txt', content: 'rewritten\n', intent: 'write a file I never read' }));
  assert.equal(overwrite.status, 'success');
  assert.equal(read('untouched.txt'), 'rewritten\n');

  const created = parsed(await writeFileExecute({ path: 'fresh/out.txt', content: 'new\n', intent: 'create a file' }));
  assert.equal(created.status, 'success');
  assert.equal(created.created, true);

  // A file that was *removed* after the read is not refused either: there is no unseen
  // content to clobber, and re-reading a path that is gone would be a dead end.
  clearReads();
  write('removed.txt', 'here\n');
  await readFileExecute({ path: 'removed.txt', intent: 'read it before it disappears' });
  fs.unlinkSync('removed.txt');

  const recreated = parsed(await writeFileExecute({ path: 'removed.txt', content: 'back\n', intent: 'recreate it' }));
  assert.equal(recreated.status, 'success');
  assert.equal(read('removed.txt'), 'back\n');
});

test('hint_file and blob count as reads, because the model saw those bytes', async () => {
  clearReads();
  write('hinted.txt', 'alpha\nbeta\n');
  await hintFileExecute({ path: 'hinted.txt', intent: 'sketch the file' });
  write('hinted.txt', 'alpha\nbeta\ngamma\n');

  const afterHint = parsed(await writeFileExecute({ path: 'hinted.txt', content: 'x\n', intent: 'write after a hint' }));
  assert.equal(afterHint.code, 'STALE_READ');

  clearReads();
  write('blobbed.txt', 'one\n');
  await blobExecute({ path: 'blobbed.txt', intent: 'blob the file' });
  write('blobbed.txt', 'one\ntwo\n');

  const afterBlob = parsed(await writeFileExecute({ path: 'blobbed.txt', content: 'y\n', intent: 'write after a blob' }));
  assert.equal(afterBlob.code, 'STALE_READ');
});

test('delete_file forgets the path it removed, so a later create is not refused', async () => {
  clearReads();
  write('doomed.txt', 'content\n');
  await readFileExecute({ path: 'doomed.txt', intent: 'read before deleting' });

  const removed = parsed(await deleteFileExecute({ path: 'doomed.txt', intent: 'remove the fixture' }));
  assert.equal(removed.status, 'success');
  assert.equal(trackedReads().has('doomed.txt'), false, 'nothing is left to guard');

  const created = parsed(await writeFileExecute({ path: 'doomed.txt', content: 'reborn\n', intent: 'create it again' }));
  assert.equal(created.status, 'success');
  assert.equal(created.created, true);
});

test('the tracking files are exempt, because update_task rewrites them whole', async () => {
  clearReads();
  write('agent/sessions/s1/task.md', '# Task list\n\nstatus: pending\n\n## Items\n\n- [ ] one\n');
  await readFileExecute({ path: 'agent/sessions/s1/task.md', intent: 'read the checklist' });
  write('agent/sessions/s1/task.md', '# Task list\n\nstatus: pending\n\n## Items\n\n- [ ] one\n- [ ] two\n');

  const stored = parsed(await writeFileExecute({
    path: 'agent/sessions/s1/task.md',
    content: '- [ ] one\n- [ ] two\n',
    intent: 'draft the checklist',
  }));

  assert.equal(stored.status, 'success', 'the fence owns the tracking files, not this guard');
  assert.equal(stored.canonicalised, true);
});

test('forgetRead() and clearReads() drop what is tracked', () => {
  clearReads();
  write('forget-me.txt', 'x\n');
  recordRead('forget-me.txt');
  assert.equal(trackedReads().size, 1);

  assert.equal(forgetRead('forget-me.txt'), true);
  assert.equal(forgetRead('forget-me.txt'), false, 'forgetting twice is not an error');
  assert.equal(readDrift('forget-me.txt').tracked, false);

  recordRead('forget-me.txt');
  clearReads();
  assert.equal(trackedReads().size, 0);
});
