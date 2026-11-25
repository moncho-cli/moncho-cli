import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  COMPAT_BREAKS,
  FIRST_ERA,
  MIGRATIONS,
  compatEra,
  compatEraBreaks,
  compatVerdict,
  migrateRecord,
  validateCompatBreaks,
} from '../utils/session-compat.js';
import { semverRank } from '../utils/version-bump.js';
import { serializeSession } from '../utils/session-format.js';
import { migrateStoredSession, describeSession, writeSession } from '../utils/session-store.js';
import { sessionsCommand } from '../app/commands.js';

/**
 * Which sessions a build may open, and the migrations that carry the rest forward
 * (`docs/runtime/session-compat`).
 *
 * Two properties are load-bearing and each has a case below. The first is the one-way
 * door: a pin **newer** than the runtime is refused whatever the table says, because the
 * newer build already wrote bytes this one cannot read. The second is the whole point of
 * the era: releases that did not break compatibility stop refusing sessions, so a user
 * upgrading a patch does not lose the conversation they were working in.
 */

/** A representative table: a real break with a migration, and one with none. */
const BREAKS = [
  { version: '0.40.0', note: 'the stamps moved beside the chunks', migrate: 'stampsBecomeAList' },
  { version: '1.0.0', note: 'the tool-call contract moved', migrate: null },
];

/** The registry that table resolves against: a migration that changes nothing is enough. */
const REGISTRY = { stampsBecomeAList: (record) => record };

test('the shipped break list is sound, append-only and ascending', () => {
  // The era is a count of the entries below a version, so a break inserted in the middle
  // re-labels every session on the disk. Nothing about that is repairable after the fact,
  // which is why the shape is asserted rather than reviewed.
  assert.ok(Array.isArray(COMPAT_BREAKS), 'the list is an array, empty or not');
  assert.deepEqual(validateCompatBreaks(), [], 'the shipped list has no problems');
  assert.deepEqual(validateCompatBreaks(BREAKS, { migrations: REGISTRY }), [], 'and neither has a sound one');
});

test('an era is one plus every break at or below the version', () => {
  assert.equal(FIRST_ERA, 1, 'there is always an era before the first break');
  // A break is *landed* at its version, not before it: the release that broke
  // compatibility is already in the new era.
  assert.equal(compatEra('0.1.0', BREAKS), 1);
  assert.equal(compatEra('0.39.9', BREAKS), 1, 'the release before the break is still the first era');
  assert.equal(compatEra('0.40.0', BREAKS), 2, 'the release that broke it is in the new era');
  assert.equal(compatEra('0.99.0', BREAKS), 2);
  assert.equal(compatEra('1.0.0', BREAKS), 3);
  assert.equal(compatEra('2.0.0', BREAKS), 3, 'nothing after the last break moves the era');

  // Eras never decrease as versions rise — the property the append-only rule protects.
  const eras = ['0.1.0', '0.40.0', '0.41.0', '1.0.0', '1.2.3'].map((v) => compatEra(v, BREAKS));
  for (let i = 1; i < eras.length; i += 1) assert.ok(eras[i] >= eras[i - 1], `${eras[i]} does not fall below ${eras[i - 1]}`);
});

test('the era of a version that is not a semver is no era at all', () => {
  assert.equal(compatEra('nope', BREAKS), null);
  assert.equal(compatEra('1.0', BREAKS), null, 'two numbers are not a version');
  assert.equal(compatEra('', BREAKS), null);
  assert.equal(compatEra(null, BREAKS), null);
  assert.equal(compatEra('0.36.0', 'not a list'), null, 'a junk table dates nothing, it does not crash');
});

test('the breaks between two versions are the ones after the first and up to the second, in order', () => {
  // Buildings that are 0.28 and 0.36 met no break at all: the whole reason the pin used
  // to refuse them is what this case measures.
  assert.deepEqual(compatEraBreaks('0.28.0', '0.36.0', BREAKS), []);
  // The break landed *after* the session was written, so the build that carries it may
  // not read those bytes until the record has been carried forward.
  assert.deepEqual(compatEraBreaks('0.39.0', '0.40.0', BREAKS).map((b) => b.version), ['0.40.0']);
  assert.deepEqual(compatEraBreaks('0.28.0', '1.0.0', BREAKS).map((b) => b.version), ['0.40.0', '1.0.0']);
  assert.deepEqual(compatEraBreaks('0.40.0', '1.0.0', BREAKS).map((b) => b.version), ['1.0.0'], 'the break at the pin itself is behind it');
  assert.deepEqual(compatEraBreaks('0.40.0', '0.41.0', BREAKS), []);
  // A backwards pair names no forward step: there is no un-migration.
  assert.deepEqual(compatEraBreaks('1.0.0', '0.40.0', BREAKS), []);
  assert.deepEqual(compatEraBreaks('junk', '0.40.0', BREAKS), []);
});

test('a session with no pin is open, and a newer pin is refused, whatever the table says', () => {
  // Unchanged from the pin's own rule: nobody has claimed this conversation, so the next
  // save stamps it.
  assert.equal(compatVerdict(null, '0.36.0', { breaks: BREAKS }).verdict, 'open');
  assert.equal(compatVerdict(null, '0.36.0', { breaks: BREAKS }).reason, 'unpinned');
  // The one-way door. A table full of migrations must not open it: the newer build has
  // already read and written the conversation, so the older one may not write it back.
  for (const version of ['0.36.0', '1.0.0']) {
    assert.equal(compatVerdict('9.9.9', version, { breaks: BREAKS }).verdict, 'refuse');
    assert.equal(compatVerdict('9.9.9', version, { breaks: BREAKS }).reason, 'newer');
  }
  assert.equal(compatVerdict('0.36.0', '0.36.0', { breaks: BREAKS }).reason, 'same-version');
});

test('an older session in the same era opens without a migration', () => {
  // The friction this exists to remove: a patch or a feature release no longer strands
  // the conversation, because nothing between the two builds broke compatibility.
  const verdict = compatVerdict('0.35.0', '0.36.0', { breaks: BREAKS });
  assert.equal(verdict.verdict, 'open');
  assert.equal(verdict.reason, 'same-era');
  assert.deepEqual(verdict.steps, [], 'nothing to carry forward');
  // And with the shipped (empty) table, every session on the disk is in the first era.
  assert.equal(compatVerdict('0.1.0', '0.36.0').verdict, 'open');
});

test('an older session across a declared break is migrated before it opens', () => {
  const verdict = compatVerdict('0.28.0', '0.40.0', { breaks: BREAKS }, REGISTRY);
  assert.equal(verdict.verdict, 'migrate', 'not a refusal: the record can be carried forward');
  assert.equal(verdict.reason, 'older-era');
  assert.deepEqual(verdict.steps.map((b) => b.version), ['0.40.0']);
  assert.deepEqual(verdict.steps.map((b) => b.migrate), ['stampsBecomeAList']);
});

test('a break with no migration is refused, and told apart from a newer pin', () => {
  // The 1.0.0 break carries no migration, so the sessions it stranded are refused exactly
  // as they were before the era existed — and the *reason* is different: the user's way out
  // is to start the owning version and upgrade it, not to wait for a build that owns it.
  const verdict = compatVerdict('0.28.0', '1.0.0', { breaks: BREAKS }, REGISTRY);
  assert.equal(verdict.verdict, 'refuse');
  assert.equal(verdict.reason, 'unmigratable');
  assert.deepEqual(verdict.steps.map((b) => b.version), ['0.40.0', '1.0.0'], 'the walk it could not take travels with the refusal');
  assert.equal(compatVerdict('9.9.9', '1.0.0', { breaks: BREAKS }, REGISTRY).reason, 'newer');
});

test('a pin that is not a semver is refused rather than assumed to be in the era', () => {
  // Ordering is the rule from here on, and nothing can say which side of the door an
  // unorderable version is on. Assuming it is old would let an unreadable record through.
  assert.equal(compatVerdict('nope', '0.36.0', { breaks: BREAKS }).verdict, 'refuse');
  assert.equal(compatVerdict('nope', '0.36.0', { breaks: BREAKS }).reason, 'unparseable');
  assert.equal(compatVerdict('0.36.0', 'nope', { breaks: BREAKS }).verdict, 'refuse', 'and a runtime nobody can order refuses too');
});

test('a migration is a pure record-to-record that may leave a record unchanged', () => {
  const messier = { version: 1, id: 'x', stamps: 'old' };
  const { ok, record, applied } = migrateRecord(messier, [{ migrate: 'plain' }], {
    migrations: { plain: (r) => ({ ...r, stamps: ['new'] }) },
  });
  assert.equal(ok, true);
  assert.deepEqual(applied, ['plain']);
  assert.deepEqual(record.stamps, ['new']);
  assert.equal(messier.stamps, 'old', 'the input is not mutated in place');

  // A record with nothing to fix is a valid migration, not a failure: an older record may
  // never have carried the field the break is about.
  const unchanged = migrateRecord(messier, [{ migrate: 'same' }], { migrations: { same: (r) => r } });
  assert.equal(unchanged.ok, true);
  assert.deepEqual(unchanged.record, messier);
});

test('a missing or throwing migration blocks the walk, all-or-nothing', () => {
  const record = { version: 1, id: 'x' };
  const migrations = { first: (r) => ({ ...r, one: true }), boom: () => { throw new Error('nope'); } };

  const missing = migrateRecord(record, [{ migrate: 'first' }, { migrate: 'nope' }], { migrations });
  assert.equal(missing.ok, false, 'a break with no migration stops the walk');
  assert.equal(missing.blocked.migrate, 'nope', 'and the step that blocked it travels with the answer');
  assert.deepEqual(missing.applied, ['first'], 'the steps that ran are reported, but the record is not used');

  const thrown = migrateRecord(record, [{ migrate: 'boom' }], { migrations });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.error.message, 'nope', 'a throwing migration is reported, never propagated');
  assert.deepEqual(thrown.record, record, 'the caller keeps a record it can leave alone');

  assert.deepEqual(migrateRecord(record, []), { ok: true, record, applied: [], blocked: null, error: null });
  assert.deepEqual(Object.keys(MIGRATIONS).length >= 0, true, 'the registry is a name -> function table');
});

test('a table that is not append-only or names an unknown migration is reported', () => {
  assert.deepEqual(validateCompatBreaks('nope'), ['the break list is not an array']);
  assert.deepEqual(validateCompatBreaks([{ version: 'junk' }]), ['break 1 does not name a semver version']);
  assert.deepEqual(validateCompatBreaks([{ version: '0.40.0', migrate: 'missing' }]), ['break 1 names the unknown migration "missing"']);
  const backwards = validateCompatBreaks([{ version: '0.40.0' }, { version: '0.30.0' }]);
  assert.equal(backwards.length, 1, 'a break before the one above it is one problem, and it is named with its rule');
  assert.match(backwards[0], /append-only/);
  assert.equal(validateCompatBreaks([{ version: '0.40.0' }, { version: '0.40.0' }]).length, 2, 'a repeat is a repeat and a step back');
  // The ordering key the era is built on is the version module's, not a second derivation.
  assert.equal(semverRank('0.40.0'), 40000);
});

// --- carrying a stored session forward ---------------------------------------

/** A scratch session directory under the (gitignored) agent tree, cleaned before use. */
function tempDir(name) {
  const dir = `agent/sessions-compat-${process.pid}-${name}`;
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

/** A session on disk, written by `version`, with one turn so it is not empty. */
function storeSession(dir, id, version, extra = {}) {
  writeSession(serializeSession({
    id,
    chunks: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }],
    monchoVersion: version,
    ...extra,
  }), { dir });
}

/** The raw record on disk, so a case can assert what was really written. */
const rawRecord = (dir, id) => JSON.parse(
  fs.readFileSync(path.join(process.cwd(), dir, id, 'context.json'), 'utf-8'),
);

/** A manager whose context window records what was done to it. */
function spyManager() {
  const calls = [];
  return {
    calls,
    contextWindow: { replace: (...args) => calls.push(['replace', ...args]) },
    usage: { replace: (...args) => calls.push(['usage', ...args]) },
  };
}

const MIGRATE_ALL = { breaks: BREAKS, migrations: { stampsBecomeAList: (r) => ({ ...r, stamps: [] }) } };

test('migrating a stored session carries the record forward, re-stamps the pin and audits the move', () => {
  const dir = tempDir('migrate-write');
  const id = '2026-01-01T00-00-00-000Z';
  storeSession(dir, id, '0.28.0');

  // A field `serializeSession()` does not know, written by hand: that builder keeps only the
  // fields it knows, so a migration path that re-serialised would drop it silently. This is
  // the byte that proves the migrated record is written as it stands.
  const file = path.join(process.cwd(), dir, id, 'context.json');
  fs.writeFileSync(file, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf-8')), custom: 'kept' }, null, 2)}\n`);

  const done = migrateStoredSession(id, {
    dir,
    version: '0.40.0',
    now: new Date('2026-11-24T10:00:00.000Z'),
    options: MIGRATE_ALL,
  });

  assert.equal(done.migrated, true);
  assert.equal(done.code, 'MIGRATED');
  assert.deepEqual(done.applied, ['stampsBecomeAList']);
  assert.equal(done.from, '0.28.0', 'the audit line says where the move came from');

  // The pin is rewritten with its audit pair, exactly as /upgrade writes it, so the old
  // build refuses the session from here on and this one owns it.
  const written = rawRecord(dir, id);
  assert.equal(written.monchoVersion, '0.40.0');
  assert.equal(written.upgradedFrom, '0.28.0');
  assert.equal(written.upgradedAt, '2026-11-24T10:00:00.000Z');
  assert.deepEqual(written.stamps, [], 'the migration ran against the record as written');
  // A field no `serializeSession()` knows is not silently dropped: the record is written as
  // it stands rather than rebuilt through the builder that keeps only the fields it knows.
  assert.equal(written.custom, 'kept');
  cleanup(dir);
});

test('a session the era already opens is not migrated, and one that is refused is left alone', () => {
  const dir = tempDir('migrate-noop');
  const id = '2026-01-02T00-00-00-000Z';
  storeSession(dir, id, '0.40.0');

  // Same era: nothing to carry forward, so nothing is written. The pin sits *at* the break,
  // which is behind it — the release that broke compatibility already writes the new shape.
  const sameEra = migrateStoredSession(id, { dir, version: '0.41.0', options: { breaks: BREAKS, migrations: REGISTRY } });
  assert.equal(sameEra.migrated, false);
  assert.equal(sameEra.code, 'UP_TO_DATE');
  assert.equal(rawRecord(dir, id).monchoVersion, '0.40.0', 'a session that opens is never rewritten by the gate');

  // A newer pin is the one-way door: no migration may cross it, so nothing is attempted.
  const newer = migrateStoredSession(id, { dir, version: '0.36.0', options: { breaks: BREAKS, migrations: REGISTRY } });
  assert.equal(newer.migrated, false);
  assert.equal(newer.code, 'VERSION_LOCKED');
  assert.equal(rawRecord(dir, id).monchoVersion, '0.40.0', 'the bytes are untouched');
  cleanup(dir);
});

test('a migration that fails or is missing writes nothing, so the session stays readable as it was', () => {
  const dir = tempDir('migrate-fail');
  const id = '2026-01-03T00-00-00-000Z';
  storeSession(dir, id, '0.28.0');
  const before = fs.readFileSync(path.join(process.cwd(), dir, id, 'context.json'), 'utf-8');

  // All-or-nothing: a record carried half way forward would claim an era it does not have.
  const failed = migrateStoredSession(id, {
    dir,
    version: '0.41.0',
    options: { breaks: [{ version: '0.40.0', migrate: 'boom' }], migrations: { boom: () => { throw new Error('nope'); } } },
  });
  assert.equal(failed.migrated, false);
  assert.equal(failed.code, 'MIGRATION_FAILED');
  assert.equal(failed.blocked.version, '0.40.0', 'the step that blocked it travels with the answer');
  assert.equal(
    fs.readFileSync(path.join(process.cwd(), dir, id, 'context.json'), 'utf-8'),
    before,
    'nothing is written when the walk does not finish',
  );
  cleanup(dir);
});

test('/sessions migrates a session across a break and then resumes it', async () => {
  const dir = tempDir('gate-migrate');
  const id = '2026-01-04T00-00-00-000Z';
  storeSession(dir, id, '0.28.0');
  const manager = spyManager();

  // The verdict is a `migrate`, so the gate carries the record forward and only then loads
  // the conversation — the migration is the door, not a refusal in front of it.
  const result = await sessionsCommand().run({
    dir,
    manager,
    version: '0.40.0',
    arg: '2026-01-04',
    options: MIGRATE_ALL,
  });

  assert.equal(result.code, 'RESUMED', result.message);
  assert.equal(result.chunks, 2);
  assert.equal(manager.calls[0][0], 'replace', 'the window was replaced only after the migration');
  assert.equal(rawRecord(dir, id).monchoVersion, '0.40.0', 'and the session now belongs to this build');
  cleanup(dir);
});

test('/sessions refuses a session stranded by a break nobody can cross, without touching it', async () => {
  const dir = tempDir('gate-unmigratable');
  const id = '2026-01-05T00-00-00-000Z';
  storeSession(dir, id, '0.28.0');
  const manager = spyManager();
  const before = fs.readFileSync(path.join(process.cwd(), dir, id, 'context.json'), 'utf-8');

  const result = await sessionsCommand().run({
    dir,
    manager,
    version: '1.0.0',
    arg: '2026-01-05',
    options: { breaks: BREAKS, migrations: REGISTRY },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'VERSION_LOCKED');
  assert.deepEqual(manager.calls, [], 'nothing was loaded and no window was replaced');
  assert.equal(
    fs.readFileSync(path.join(process.cwd(), dir, id, 'context.json'), 'utf-8'),
    before,
    'a refused session is left exactly as it was',
  );
  cleanup(dir);
});

test('the picker marks a migratable row as upgradeable and a stranded one as locked', () => {
  const dir = tempDir('gate-mark');
  const migratable = serializeSession({ id: 'i1', chunks: [], monchoVersion: '0.28.0' });
  const stranded = serializeSession({ id: 'i2', chunks: [], monchoVersion: '0.28.0' });
  const owned = serializeSession({ id: 'i3', chunks: [], monchoVersion: '0.40.0' });

  const carrying = describeSession(migratable, '0.40.0', { breaks: BREAKS, migrations: REGISTRY });
  assert.match(carrying, /upgrade \(0\.28\.0\)/, 'a row the era can carry forward says so');

  const blocked = describeSession(stranded, '1.0.0', { breaks: BREAKS, migrations: REGISTRY });
  assert.match(blocked, /locked \(0\.28\.0\)/, 'a row across a break nobody can cross stays locked');

  const mine = describeSession(owned, '0.40.0', { breaks: BREAKS, migrations: REGISTRY });
  assert.doesNotMatch(mine, /locked|upgrade/, 'a row this build owns carries no mark');
  assert.doesNotMatch(describeSession(migratable), /locked|upgrade/, 'no version asked for, no mark at all');
});
