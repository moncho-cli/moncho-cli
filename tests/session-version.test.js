import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  DECLARED_VERSION,
  VERSION_ENV,
  canOpenSession,
  runningVersion,
  sessionVersion,
  sessionVersionRefusal,
  upgradedPin,
} from '../utils/session-version.js';
import { serializeSession, sessionMonchoVersion } from '../utils/session-format.js';
import { writeSession } from '../utils/session-store.js';
import { listSessions } from '../utils/session-store.js';
import { moveSession } from '../utils/session-move.js';
import { sessionsCommand } from '../app/commands.js';
import { upgradeCommand } from '../app/upgrade-command.js';

/**
 * Which version is running, and which sessions it may open
 * (`docs/runtime/session-version`).
 *
 * The rule these cases protect is the **one-way door**: bytes a newer build wrote may not be
 * opened by an older one, which would write them back in a shape the newer build's record no
 * longer means. Ordering is what keeps it shut, so a newer pin is refused and an older one
 * opens wherever the releases declared no break (`docs/runtime/session-compat`). The ways to
 * get this wrong are each a case below — refusing an unpinned record (which strands every
 * session on disk) and letting an *older* build open a *newer* session.
 */

/** A record as `serializeSession()` builds it, with the pin as the argument under test. */
const record = (monchoVersion, id = '2026-11-23T21-50-30-535Z') =>
  serializeSession({ id, chunks: [], monchoVersion });

/** A scratch session directory under the (gitignored) agent tree, cleaned before use. */
function tempDir(name) {
  const dir = `agent/sessions-version-${process.pid}-${name}`;
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test('the running version comes from the runner and falls back to the manifest', () => {
  // The runner chose which installed payload to mount, so its word is the truth.
  assert.equal(runningVersion({ [VERSION_ENV]: '0.28.2' }), '0.28.2');
  assert.equal(runningVersion({ [VERSION_ENV]: '  0.28.2  ' }), '0.28.2', 'surrounding space is trimmed');
  // A checkout run through ./start.sh has no runner: the manifest is what this code is.
  assert.equal(runningVersion({}), DECLARED_VERSION);
  assert.equal(runningVersion({ [VERSION_ENV]: '' }), DECLARED_VERSION, 'an empty value is not a version');
  assert.match(DECLARED_VERSION, /^\d+\.\d+\.\d+$/, 'the manifest version is a semver');
});

test('a session with no pin is openable and is stamped by the next save', () => {
  // The record written before the field existed: no claim, so no refusal.
  const legacy = { id: 'old', chunks: [], version: 1 };
  assert.equal(sessionVersion(legacy), null);
  assert.equal(canOpenSession(legacy, '9.9.9'), true, 'an unclaimed conversation is open to any build');

  // And the first save under that build makes the claim.
  assert.equal(sessionMonchoVersion(record(undefined)), DECLARED_VERSION, 'a plain save stamps the running build');
});

test('a session pinned to the running version opens', () => {
  assert.equal(canOpenSession(record('0.28.3'), '0.28.3'), true);
});

test('a newer pin is refused, and the refusal names the command that opens it', () => {
  // The one-way door: 0.28.2 may not read bytes 0.28.3 wrote, whatever the two versions are.
  const locked = record('0.28.3');
  assert.equal(canOpenSession(locked, '0.28.2'), false);

  const message = sessionVersionRefusal(locked, '0.28.2');
  assert.match(message, /0\.28\.3/, 'it names the version that owns the session');
  assert.match(message, /this 0\.28\.2/, 'and the one that refused it');
  assert.match(message, /moncho-cli --version 0\.28\.3/, 'the exact command is the way in');
  assert.match(message, /\/upgrade/, 'and the command that moves it forward');
});

test('the pin is judged by era, so an older session opens and a newer one is refused', () => {
  // The whole change from strict equality: 0.29.0 opens 0.28.0's record, because nothing
  // between the two releases declared a break (`docs/runtime/session-compat`). Equality cost
  // the user every session on disk for a patch release, which is the friction this removes.
  assert.equal(canOpenSession(record('0.28.0'), '0.29.0'), true);
  // The door stays shut the other way, and ordering is what shuts it: 0.28.0 must not read
  // bytes 0.29.0 wrote, because it would write them back in a shape 0.29.0 cannot read.
  assert.equal(canOpenSession(record('0.29.0'), '0.28.0'), false);
});

test('an upgrade rewrites the claim so the old version refuses it afterwards', () => {
  const before = record('0.28.2');
  assert.equal(canOpenSession(before, '0.28.2'), true);

  const pin = upgradedPin('0.28.2', '0.28.3', new Date('2026-11-24T09:12:00.000Z'));
  const after = serializeSession({ ...before, chunks: [], ...pin });

  assert.equal(canOpenSession(after, '0.28.3'), true, 'the new version owns it now');
  assert.equal(canOpenSession(after, '0.28.2'), false, 'and the old one no longer may');
});

test('the audit line records where an upgrade came from and when', () => {
  const at = new Date('2026-11-24T09:12:00.000Z');
  const after = serializeSession({
    id: 'x',
    chunks: [],
    ...upgradedPin('0.28.2', '0.28.3', at),
  });

  assert.equal(after.monchoVersion, '0.28.3');
  assert.equal(after.upgradedFrom, '0.28.2');
  assert.equal(after.upgradedAt, at.toISOString());

  // An unpinned record upgraded is honest about having no origin, rather than claiming one.
  const fromNothing = upgradedPin(null, '0.28.3', at);
  assert.equal(fromNothing.upgradedFrom, null);
  const record_ = serializeSession({ id: 'y', chunks: [], ...fromNothing });
  assert.equal(record_.upgradedFrom, undefined, 'no origin is written rather than a false one');
});

// --- the gate in /sessions ---------------------------------------------------

/** A session on disk, written by `version`, with one turn so it is not empty. */
function storeSession(dir, id, version) {
  writeSession(serializeSession({
    id,
    chunks: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }],
    monchoVersion: version,
  }), { dir });
}

/** A manager whose context window records what was done to it. */
function spyManager() {
  const calls = [];
  return {
    calls,
    contextWindow: {
      replace: (...args) => calls.push(['replace', ...args]),
    },
    usage: { replace: (...args) => calls.push(['usage', ...args]) },
  };
}

test('/sessions refuses a locked session before touching the conversation', async () => {
  const dir = tempDir('gate-refuse');
  // A *newer* pin is the door that stays shut: 0.28.3 may not read what 0.28.4 wrote.
  storeSession(dir, '2026-01-01T00-00-00-000Z', '0.28.4');
  const manager = spyManager();

  const result = await sessionsCommand().run({
    arg: '2026-01-01', dir, manager, version: '0.28.3',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'VERSION_LOCKED');
  assert.match(result.message, /moncho-cli --version 0\.28\.4/, 'it names the way in');
  assert.equal(result.monchoVersion, '0.28.4', 'the pin travels with the refusal');
  assert.deepEqual(manager.calls, [], 'nothing was loaded and no window was replaced');
  cleanup(dir);
});

test('/sessions opens a session written by the running version', async () => {
  const dir = tempDir('gate-open');
  storeSession(dir, '2026-01-02T00-00-00-000Z', '0.28.3');
  const manager = spyManager();

  const result = await sessionsCommand().run({
    arg: '2026-01-02', dir, manager, version: '0.28.3',
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, 'RESUMED');
  assert.equal(result.chunks, 2);
  assert.equal(manager.calls[0][0], 'replace', 'the window was replaced');
  cleanup(dir);
});

test('the picker marks a locked row and still lists it', async () => {
  const dir = tempDir('gate-mark');
  storeSession(dir, '2026-01-02T00-00-00-000Z', '0.28.2'); // older, nothing broke: open
  storeSession(dir, '2026-01-03T00-00-00-000Z', '0.28.4'); // newer: locked
  storeSession(dir, '2026-01-04T00-00-00-000Z', '0.28.3'); // this build: owned

  // No choose function, so /sessions answers with the lines it would have shown.
  const result = await sessionsCommand().run({ dir, version: '0.28.3' });
  assert.equal(result.code, 'LISTED');
  assert.equal(result.lines.length, 3, 'every row is shown: a lock is not a disappearance');

  const row = (id) => result.lines.find((line) => line.includes(id));
  assert.match(row('2026-01-03'), /locked \(0\.28\.4\)/, 'the locked row says why');
  assert.doesNotMatch(row('2026-01-02'), /locked/, 'an older row the era opens carries no mark');
  assert.doesNotMatch(row('2026-01-04'), /locked/, 'the row this build owns carries no mark');
  cleanup(dir);
});

test('the picker refuses the locked row it was told to open', async () => {
  const dir = tempDir('gate-choose');
  storeSession(dir, '2026-01-05T00-00-00-000Z', '0.28.4');
  const manager = spyManager();

  const result = await sessionsCommand().run({
    dir, manager, version: '0.28.3',
    // The picker hands back the index of the first row, which is the locked one.
    choose: async () => 0,
  });

  assert.equal(result.code, 'VERSION_LOCKED');
  assert.deepEqual(manager.calls, []);
  cleanup(dir);
});

test('an unpinned session still opens, and the next save claims it', async () => {
  // The whole point of the `null` answer: history on disk is not stranded by an upgrade.
  const dir = tempDir('gate-legacy');
  writeSession(serializeSession({
    id: '2026-01-06T00-00-00-000Z',
    chunks: [{ role: 'user', content: 'legacy' }],
  }), { dir });
  // Strip the pin to imitate a record written before the field existed.
  const file = path.join(process.cwd(), dir, '2026-01-06T00-00-00-000Z', 'context.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  delete raw.monchoVersion;
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);

  const manager = spyManager();
  const result = await sessionsCommand().run({
    arg: '2026-01-06', dir, manager, version: '0.28.3',
  });
  assert.equal(result.code, 'RESUMED', 'an unclaimed conversation opens in any build');
  cleanup(dir);
});

// --- moving a session forward -------------------------------------------------

test('a move carries every file the session owns, and leaves the old id empty', () => {
  const dir = tempDir('move-files');
  const from = '2026-01-01T00-00-00-000Z';
  storeSession(dir, from, '0.28.2');

  // Everything a real session owns, so the rename is proved over all of it at once.
  const folder = path.join(process.cwd(), dir, from);
  fs.writeFileSync(path.join(folder, 'task.md'), '# Task list\n');
  fs.writeFileSync(path.join(folder, 'implementation_plan.md'), '# plan\n');
  fs.writeFileSync(path.join(folder, 'conversation.json'), '{"chunks":[]}\n');
  fs.writeFileSync(path.join(folder, 'chunkpaction.json'), '{"1":[]}\n');

  const { from: was, to, folder: moved } = moveSession(from, {
    dir, now: new Date('2026-11-24T10:00:00.000Z'),
  });

  assert.equal(was, from);
  assert.equal(to, '2026-11-24T10-00-00-000Z', 'the new id is the timestamp of the move');
  for (const file of ['context.json', 'task.md', 'implementation_plan.md', 'conversation.json', 'chunkpaction.json']) {
    assert.ok(fs.existsSync(path.join(moved, file)), `${file} moved with the folder`);
  }
  assert.equal(fs.existsSync(folder), false, 'the old folder is gone, not duplicated');
  cleanup(dir);
});

test('a moved session sorts first, so --continue finds it', () => {
  const dir = tempDir('move-order');
  storeSession(dir, '2026-01-01T00-00-00-000Z', '0.28.2');
  storeSession(dir, '2026-06-01T00-00-00-000Z', '0.28.3');

  // The older conversation is the one being upgraded, and it must become the newest.
  assert.equal(listSessions({ dir })[0].id, '2026-06-01T00-00-00-000Z');
  moveSession('2026-01-01T00-00-00-000Z', { dir, now: new Date('2026-11-24T10:00:00.000Z') });
  assert.equal(listSessions({ dir })[0].id, '2026-11-24T10-00-00-000Z');
  cleanup(dir);
});

test('a move refuses to overwrite a session that already sits at the new id', () => {
  const dir = tempDir('move-collide');
  storeSession(dir, '2026-01-01T00-00-00-000Z', '0.28.2');
  storeSession(dir, '2026-11-24T10-00-00-000Z', '0.28.3');
  const before = fs.readFileSync(
    path.join(process.cwd(), dir, '2026-11-24T10-00-00-000Z', 'context.json'), 'utf-8',
  );

  assert.throws(
    () => moveSession('2026-01-01T00-00-00-000Z', { dir, now: new Date('2026-11-24T10:00:00.000Z') }),
    (error) => error.code === 'TARGET_EXISTS',
  );
  // Nothing moved and nothing was clobbered.
  assert.ok(fs.existsSync(path.join(process.cwd(), dir, '2026-01-01T00-00-00-000Z')));
  assert.equal(
    fs.readFileSync(path.join(process.cwd(), dir, '2026-11-24T10-00-00-000Z', 'context.json'), 'utf-8'),
    before,
    'the session at the target is untouched',
  );
  cleanup(dir);
});

test('a move of a session that is not there says so instead of creating one', () => {
  const dir = tempDir('move-missing');
  fs.mkdirSync(path.join(process.cwd(), dir), { recursive: true });
  assert.throws(
    () => moveSession('2026-01-01T00-00-00-000Z', { dir }),
    (error) => error.code === 'UNKNOWN_SESSION',
  );
  cleanup(dir);
});

// --- /upgrade -----------------------------------------------------------------

test('/upgrade moves the session, pins it to the running version and asks to close', () => {
  const dir = tempDir('upgrade-ok');
  const from = '2026-01-01T00-00-00-000Z';
  storeSession(dir, from, '0.28.2');

  const result = upgradeCommand().run({
    dir,
    version: '0.28.3',
    running: '0.28.2',
    now: new Date('2026-11-24T10:00:00.000Z'),
    // The recorder shape the loop passes: an id and the pin being written.
    sessions: { id: from, monchoVersion: '0.28.2' },
  });

  assert.equal(result.ok, true, result.message);
  assert.equal(result.code, 'UPGRADED');
  assert.equal(result.from, from);
  assert.equal(result.id, '2026-11-24T10-00-00-000Z', 'the session moved to a current id');
  assert.equal(result.monchoVersion, '0.28.3');
  assert.equal(result.upgradedFrom, '0.28.2');
  assert.equal(result.close, true, 'the process ends: the container cannot become the new version');
  assert.match(result.message, /--continue/, 'and the user is told how to come back');

  // The record on disk now carries the new pin, and the old id is gone.
  assert.equal(listSessions({ dir })[0].monchoVersion, '0.28.3');
  assert.equal(fs.existsSync(path.join(process.cwd(), dir, from)), false);
  cleanup(dir);
});

test('/upgrade re-pins a session this build may read and refuses one it may not', () => {
  const id = '2026-01-01T00-00-00-000Z';

  // Older pin, nothing broke between the two releases: this build may read the bytes, so the
  // upgrade carries them forward and re-stamps the claim — exactly the pin the equality rule
  // used to refuse, which is the friction this removes.
  const dir = tempDir('upgrade-older');
  storeSession(dir, id, '0.28.2');

  const carried = upgradeCommand().run({
    dir, version: '0.28.3', running: '0.28.2', sessions: { id, monchoVersion: '0.28.2' },
  });
  assert.equal(carried.ok, true, carried.message);
  assert.equal(carried.code, 'UPGRADED');
  assert.equal(carried.monchoVersion, '0.28.3');
  cleanup(dir);

  // A *newer* pin: a build may only write a conversation it may read, and ordering puts this
  // one on the far side of the one-way door. Nothing moves and the way in is named.
  const lockedDir = tempDir('upgrade-locked');
  storeSession(lockedDir, id, '0.36.0');

  const locked = upgradeCommand().run({
    dir: lockedDir, version: '0.37.0', running: '0.35.0', sessions: { id, monchoVersion: '0.36.0' },
  });
  assert.equal(locked.ok, false);
  assert.equal(locked.code, 'VERSION_LOCKED');
  assert.match(locked.message, /moncho-cli --version 0\.36\.0/, 'it names the version that may open it');
  assert.ok(fs.existsSync(path.join(process.cwd(), lockedDir, id)), 'nothing moved');
  cleanup(lockedDir);
});

test('/upgrade on a session already at the running version is a no-op', () => {
  const dir = tempDir('upgrade-current');
  const id = '2026-01-01T00-00-00-000Z';
  storeSession(dir, id, '0.28.3');

  const result = upgradeCommand().run({
    dir, version: '0.28.3', running: '0.28.3', sessions: { id, monchoVersion: '0.28.3' },
  });
  assert.equal(result.code, 'ALREADY_CURRENT');
  assert.ok(fs.existsSync(path.join(process.cwd(), dir, id)), 'no second rename');
  cleanup(dir);
});

test('/upgrade refuses an argument and a front end with no session', () => {
  assert.equal(upgradeCommand().run({ arg: 'now', sessions: { id: 'x' } }).code, 'UNKNOWN_ARG');
  assert.equal(upgradeCommand().run({ sessions: null }).code, 'NO_SESSION');
});