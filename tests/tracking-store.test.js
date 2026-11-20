import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  trackingPaths, readTaskContent, readPlanContent, writeTaskContent, writePlanContent,
  ensureTrackingFiles, TRACKING_FILE_NAMES,
} from '../utils/tracking-store.js';
import {
  registerSession, clearSession, getSessionTaskContent, getSessionPlanContent,
} from '../utils/host.js';
import { sessionDir } from '../utils/session-store.js';
import { execute as updateTaskExecute } from '../tools/update_task.js';
import { validateTrackingFile } from '../utils/tracking-format.js';
import { readChecklist } from '../app/work-drive.js';
import { readTaskItems } from '../app/work-command.js';

/**
 * *Where* the two tracking files live: one pair per session, under its folder.
 *
 * The rule has two sources and one order (session file, then the session record), and a
 * third that is **not** one: the project root. A checklist belongs to the conversation
 * working through it, so with no session there is no store at all — a root `task.md` was
 * an artefact of the old flat layout, and these cases pin down that neither half of the
 * store reaches it. They exist because the readers used to disagree: `update_task` saw an
 * empty session copy while the work drive saw a file, so a session could report zero
 * items with a populated checklist sitting right there.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-tracking-test-'));
process.chdir(root);

const ID = '2026-02-14T10-30-00-000Z';
const FOLDER = sessionDir(ID, { dir: 'agent/sessions' });

const TASK = '# Task list\n\nstatus: pending\n\n## Items\n\n- [ ] item one\n- [ ] item two\n';
const PLAN = '# item one\n\nstatus: in progress\n\n## Steps\n\n- [ ] write it\n';

function writeFile(name, content) {
  fs.mkdirSync(path.dirname(name), { recursive: true });
  fs.writeFileSync(name, content, 'utf-8');
}

const read = (name) => fs.readFileSync(name, 'utf-8');
const exists = (name) => fs.existsSync(path.join(root, name));

test.afterEach(() => {
  clearSession();
  fs.rmSync(path.join(root, 'agent'), { recursive: true, force: true });
  for (const name of Object.values(TRACKING_FILE_NAMES)) {
    fs.rmSync(path.join(root, name), { force: true });
  }
});

test('a registered session owns a folder, and the files live in it', () => {
  registerSession({ id: ID });

  const paths = trackingPaths();
  assert.equal(paths.folder, FOLDER);
  assert.equal(paths.task, `${FOLDER}/task.md`);
  assert.equal(paths.plan, `${FOLDER}/implementation_plan.md`);

  // No session at all means no store at all: the root pair is not a fallback.
  clearSession();
  assert.deepEqual(trackingPaths(), { task: null, plan: null, folder: null });
  assert.equal(readTaskContent(), null, 'nothing is read from the project root');
});

test('ensureTrackingFiles gives a session its own canonical pair', () => {
  registerSession({ id: ID });

  const ready = ensureTrackingFiles();
  assert.deepEqual(ready.created, [`${FOLDER}/task.md`, `${FOLDER}/implementation_plan.md`]);

  // A new session starts from the canonical skeleton, never from a root file left in the
  // tree: the root is the operator's, and a checklist is not a property of the project.
  const task = read(`${FOLDER}/task.md`);
  const checked = validateTrackingFile(task, { kind: 'task' });
  assert.equal(checked.ok, true, checked.problems.join('; '));
  assert.equal(checked.items.length, 1);
  assert.match(checked.items[0].text, /^\(no items? recorded\)$/, 'the skeleton placeholder, not a root file\'s items');
  assert.equal(validateTrackingFile(read(`${FOLDER}/implementation_plan.md`), { kind: 'plan' }).ok, true);

  // The record snapshot is seeded too, so a resume with no folder still reads a checklist.
  assert.equal(getSessionTaskContent(), task);

  // Running it twice changes nothing: the files are already there.
  assert.deepEqual(ensureTrackingFiles().created, []);
});

test('a root task.md is neither read as a checklist nor rewritten', () => {
  writeFile('task.md', '# Root\n\nstatus: pending\n\n## Items\n\n- [ ] root item\n');
  registerSession({ id: ID });
  ensureTrackingFiles();

  // The session's own pair is the whole store, even while a root file sits right there.
  assert.equal(readTaskContent(), read(`${FOLDER}/task.md`));
  assert.deepEqual(readChecklist().map((item) => item.text), ['(no items recorded)'], 'not the root item');

  writeTaskContent(TASK);
  assert.ok(read('task.md').includes('- [ ] root item'), 'the root file is never touched');
});

test('the session copy answers only when its file is gone', () => {
  writeFile(`${FOLDER}/task.md`, TASK);
  writeFile(`${FOLDER}/implementation_plan.md`, PLAN);
  registerSession({ id: ID }, '# stale\n\nstatus: pending\n\n## Items\n\n- [ ] stale\n');

  // The file is what a human edits, so it wins while it exists.
  assert.equal(readTaskContent(), TASK);
  assert.equal(readChecklist().length, 2);
  assert.equal(readTaskItems().length, 2);

  fs.rmSync(path.join(root, `${FOLDER}/task.md`));

  // The record snapshot takes over, so a session whose folder was cleaned still reads.
  assert.equal(readTaskContent(), '# stale\n\nstatus: pending\n\n## Items\n\n- [ ] stale\n');
  assert.equal(readChecklist().length, 1);
});

test('a write lands in the session file and in the record snapshot', () => {
  registerSession({ id: ID });
  ensureTrackingFiles();

  const written = writeTaskContent(TASK);
  assert.equal(written.path, `${FOLDER}/task.md`);
  assert.equal(written.verified, true);
  assert.equal(read(`${FOLDER}/task.md`), TASK);
  assert.equal(getSessionTaskContent(), TASK);

  writePlanContent(PLAN);
  assert.equal(read(`${FOLDER}/implementation_plan.md`), PLAN);
  assert.equal(getSessionPlanContent(), PLAN);
});

test('update_task reads and writes the checklist of its own session', async () => {
  writeFile('task.md', '# Root\n\nstatus: pending\n\n## Items\n\n- [ ] root item\n');
  registerSession({ id: ID });
  ensureTrackingFiles();
  writeTaskContent(TASK);
  writePlanContent(PLAN);

  const listed = JSON.parse(await updateTaskExecute({ action: 'list', intent: 'see progress' }));
  assert.equal(listed.status, 'ok');
  assert.equal(listed.progress.total, 2, 'the session checklist, not the root one');
  assert.equal(listed.next, 'item one');

  const done = JSON.parse(await updateTaskExecute({
    action: 'complete', item: 'item one', steps: ['write it'], intent: 'finish item one',
  }));
  assert.equal(done.status, 'success');
  assert.equal(done.next, 'item two');

  // The session file moved, the root file did not.
  assert.ok(read(`${FOLDER}/task.md`).includes('- [x] item one'));
  assert.ok(read('task.md').includes('- [ ] root item'), 'the root file is never touched');
  assert.equal(getSessionTaskContent(), read(`${FOLDER}/task.md`));
  assert.ok(read(`${FOLDER}/implementation_plan.md`).startsWith('# item two'));
});

test('without a session there is no store, so the project root is never one', () => {
  writeFile('task.md', TASK);

  // A root file is the operator's, not a checklist: it is not read, and it is not a place
  // the harness may write either. Both directions are the same rule.
  assert.deepEqual(trackingPaths(), { task: null, plan: null, folder: null });
  assert.equal(readTaskContent(), null);
  assert.throws(
    () => writeTaskContent('# Root\n\nstatus: done\n\n## Items\n\n- [x] done\n'),
    (error) => error.code === 'NO_SESSION',
  );

  assert.ok(read('task.md').includes('- [ ] item one'), 'the root file is left exactly as it was');
  assert.equal(exists('agent'), false, 'a bare tool call never creates a session folder');});

test('seeding is a session affair, so it never creates the root pair', () => {
  // No session registered: `ensureTrackingFiles()` must be a no-op. Seeding the root
  // files here would resurrect exactly the pair the per-session move removed, and a
  // resume test that runs with no session would leave them in the tree.
  const ready = ensureTrackingFiles();

  assert.deepEqual(ready, { task: null, plan: null, folder: null, created: [] });
  assert.equal(exists('task.md'), false);
  assert.equal(exists('implementation_plan.md'), false);
  assert.equal(exists('agent'), false);
});