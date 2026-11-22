import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { refCommand, parseRefArg, sourcePair, findSource, FORCE_FLAG } from '../app/ref-command.js';
import { createDefaultCommands } from '../app/commands.js';
import { writeSession, listSessions } from '../utils/session-store.js';
import { registerSession, clearSession, registerTrackingNotifier, clearTrackingNotifier } from '../utils/host.js';
import { ensureTrackingFiles, readTaskContent, readPlanContent } from '../utils/tracking-store.js';
import { sessionDir } from '../utils/session-store.js';

/**
 * `/ref` (`docs/interface/session-ref`): carry a previous session's tracking pair into
 * this one, without carrying its conversation.
 *
 * The port is a write, so the cases pin the three things a write must get right: it reads
 * the *source* pair, it lands in the *current* session's folder, and it never replaces
 * what the user wrote without asking.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-ref-'));
process.chdir(root);

const SOURCE = '2026-04-01T08-00-00-000Z';
const CURRENT = '2026-04-02T09-00-00-000Z';
const DIR = 'agent/sessions';

const SOURCE_TASK = '# Task list\n\nstatus: in progress: one\n\n## Items\n\n- [ ] carried item\n- [x] done item\n';
const SOURCE_PLAN = '# carried item\n\nstatus: in progress\n\n## Steps\n\n- [ ] first step\n';
const CURRENT_TASK = '# Task list\n\nstatus: pending\n\n## Items\n\n- [ ] my own item\n';

const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf-8');

function seedSource() {
  writeSession({
    id: SOURCE,
    createdAt: '2026-04-01T08:00:00.000Z',
    model: 'test/model',
    chunks: [{ role: 'user', content: 'worked there' }],
    taskContent: SOURCE_TASK,
    planContent: SOURCE_PLAN,
  }, { dir: DIR });
}

function seedCurrent() {
  registerSession({ id: CURRENT });
  ensureTrackingFiles({ dir: DIR });
  fs.writeFileSync(path.join(root, sessionDir(CURRENT, { dir: DIR }), 'task.md'), CURRENT_TASK, 'utf-8');
}

test.afterEach(() => {
  clearSession();
  clearTrackingNotifier();
  fs.rmSync(path.join(root, 'agent'), { recursive: true, force: true });
});

test('/ref ships in the default registry, with refer as an alias', () => {
  const registry = createDefaultCommands();
  assert.equal(registry.has('ref'), true);
  assert.equal(registry.has('refer'), true);
  assert.equal(registry.get('ref'), registry.get('refer'));
});

test('parseRefArg() reads the id and the force flag in either order', () => {
  assert.deepEqual(parseRefArg(''), { id: '', force: false, unknown: [] });
  assert.deepEqual(parseRefArg('2026-04-01'), { id: '2026-04-01', force: false, unknown: [] });
  assert.deepEqual(parseRefArg(`${FORCE_FLAG} 2026-04-01`), { id: '2026-04-01', force: true, unknown: [] });
  assert.deepEqual(parseRefArg(`2026-04-01 ${FORCE_FLAG}`), { id: '2026-04-01', force: true, unknown: [] });
  assert.deepEqual(parseRefArg('a b').unknown, ['b']);
});

test('sourcePair() canonicalises what the record holds', () => {
  const pair = sourcePair({
    version: 1,
    id: SOURCE,
    createdAt: '2026-04-01T08:00:00.000Z',
    chunks: [{ role: 'user', content: 'worked there' }],
    taskContent: SOURCE_TASK,
    planContent: SOURCE_PLAN,
  });
  assert.equal(pair.task, SOURCE_TASK);
  assert.equal(pair.plan, SOURCE_PLAN);

  // A session that never used the checklist carries nothing to port.
  const empty = sourcePair({ version: 1, id: SOURCE, createdAt: '2026-04-01T08:00:00.000Z', chunks: [] });
  assert.equal(empty.task, null);
  assert.equal(empty.plan, null);
});

test('findSource() resolves an id, a prefix, and refuses what it cannot read', () => {
  seedSource();
  const sessions = listSessions({ dir: DIR });
  assert.equal(sessions.length, 1);

  assert.equal(findSource(SOURCE, { dir: DIR }).session.id, SOURCE);
  assert.equal(findSource('2026-04-01', { dir: DIR }).session.id, SOURCE);
  assert.equal(findSource('nope', { dir: DIR }).error, 'UNKNOWN_SESSION');
});

test('/ref ports the pair into the current session and leaves the source alone', async () => {
  seedSource();
  seedCurrent();

  const announced = [];
  registerTrackingNotifier({ notify: (update) => { announced.push(update); return []; } });

  const result = await refCommand().run({ arg: SOURCE, dir: DIR, confirm: async () => true });

  assert.equal(result.ok, true);
  assert.equal(result.code, 'PORTED');
  assert.equal(result.from, SOURCE);
  assert.equal(readTaskContent(), SOURCE_TASK);
  assert.equal(readPlanContent(), SOURCE_PLAN);

  // The port is announced as a tracking write, so the user sees what landed.
  assert.equal(announced.length, 1);
  assert.equal(announced[0].taskWritten, true);
  assert.equal(announced[0].planWritten, true);

  // The source session's own record is untouched.
  assert.equal(read(`${sessionDir(SOURCE, { dir: DIR })}/context.json`).includes('worked there'), true);
});

test('/ref asks before replacing the current pair, and a no changes nothing', async () => {
  seedSource();
  seedCurrent();

  let asked = null;
  const refused = await refCommand().run({
    arg: SOURCE,
    dir: DIR,
    confirm: async (question) => { asked = question; return false; },
  });

  assert.equal(refused.code, 'CANCELLED');
  assert.match(asked, /Replace/);
  assert.equal(readTaskContent(), CURRENT_TASK, 'the user\'s own checklist is still there');
});

test('/ref --force replaces without asking', async () => {
  seedSource();
  seedCurrent();

  let asked = false;
  const result = await refCommand().run({
    arg: `${SOURCE} ${FORCE_FLAG}`,
    dir: DIR,
    confirm: async () => { asked = true; return false; },
  });

  assert.equal(result.code, 'PORTED');
  assert.equal(asked, false, 'the force flag skips the question');
  assert.equal(readTaskContent(), SOURCE_TASK);
});

test('/ref with no id opens the picker and ports the chosen session', async () => {
  seedSource();
  seedCurrent();

  const labels = [];
  const result = await refCommand().run({
    dir: DIR,
    choose: async (items) => { labels.push(...items); return 0; },
    confirm: async () => true,
  });

  assert.equal(result.code, 'PORTED');
  assert.equal(labels.length, 1);
  assert.equal(readTaskContent(), SOURCE_TASK);
});

test('/ref refuses a cancelled picker and a front end with no picker', async () => {
  seedSource();
  seedCurrent();

  const cancelled = await refCommand().run({ dir: DIR, choose: async () => null });
  assert.equal(cancelled.code, 'CANCELLED');

  const noPicker = await refCommand().run({ dir: DIR });
  assert.equal(noPicker.code, 'NEEDS_ID');
  assert.equal(noPicker.sessions.length, 1);
});

test('/ref refuses an unknown session and an empty source', async () => {
  seedSource();
  seedCurrent();

  const unknown = await refCommand().run({ arg: 'nope', dir: DIR });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'UNKNOWN_SESSION');

  // A source that never wrote a checklist has nothing to port.
  writeSession({ id: '2026-04-03T00-00-00-000Z', chunks: [] }, { dir: DIR });
  const empty = await refCommand().run({ arg: '2026-04-03', dir: DIR, confirm: async () => true });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'EMPTY_SOURCE');
});

test('/ref reports NO_SESSIONS when nothing is stored', async () => {
  const result = await refCommand().run({ dir: DIR });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'NO_SESSIONS');
});
