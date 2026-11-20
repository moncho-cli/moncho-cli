import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BUMP_DISTANCES,
  bumpDistance,
  classifyChange,
  evaluateBump,
  nextVersion,
  parseSemver,
} from '../utils/version-bump.js';
import { applyBump, checkBump } from '../scripts/bump-version.mjs';

/**
 * The version bump a session owes (docs/maintainer/version-bump).
 *
 * `package.json#version` is the single source of the release tag, so a session that
 * changes behaviour and leaves the number alone makes the next release carry more than
 * its tag says. The rule is deliberately loose in one direction — one step is enough
 * however many things the session changed — and strict in the other: no step, or a step
 * backwards, is refused. These cases prove the arithmetic, the two files moving
 * together, and the documents that state the rule.
 */

const root = process.cwd();

/** A throwaway directory holding a manifest and a lockfile to bump. */
function tempProject({ version = '1.2.3', lock = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-bump-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'moncho-cli', version, type: 'module' }, null, 2)}\n`,
    'utf-8'
  );
  if (lock) {
    fs.writeFileSync(
      path.join(dir, 'package-lock.json'),
      `${JSON.stringify(
        {
          name: 'moncho-cli',
          version,
          lockfileVersion: 3,
          packages: { '': { name: 'moncho-cli', version, license: 'MIT' } },
        },
        null,
        2
      )}\n`,
      'utf-8'
    );
  }
  return dir;
}

const readJson = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));

test('parseSemver() accepts x.y.z with an optional prerelease, and rejects what is not a version', () => {
  assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: null });
  assert.equal(parseSemver('0.3.0-rc.1').prerelease, 'rc.1');
  assert.equal(parseSemver('10.0.0+build.7').major, 10);

  for (const junk of ['', '1.2', 'v1.2.3', '1.2.3.4', 'x.y.z', '01.2.3', null, undefined, 1.23]) {
    assert.equal(parseSemver(junk), null, `${JSON.stringify(junk)} is not a version`);
  }
});

test('bumpDistance() names the step between two versions, including none and backwards', () => {
  assert.equal(bumpDistance('1.2.3', '1.2.4'), 'patch');
  assert.equal(bumpDistance('1.2.3', '1.3.0'), 'minor');
  assert.equal(bumpDistance('1.2.3', '2.0.0'), 'major');
  // A jump past several steps is still one named step: the largest component that moved.
  assert.equal(bumpDistance('1.2.3', '2.5.9'), 'major');
  assert.equal(bumpDistance('1.2.3', '1.9.9'), 'minor');
  assert.equal(bumpDistance('1.2.3', '1.2.3'), 'none');
  assert.equal(bumpDistance('1.2.3', '1.2.2'), 'backwards');
  assert.equal(bumpDistance('2.0.0', '1.9.9'), 'backwards');
  assert.equal(bumpDistance('1.2.3', 'nope'), null, 'an unreadable version has no distance');

  // The three forward distances are the ones the rule can accept.
  assert.deepEqual(BUMP_DISTANCES, ['none', 'patch', 'minor', 'major']);
});

test('nextVersion() steps a version forward, and classifyChange() takes the largest kind named', () => {
  assert.equal(nextVersion('1.2.3'), '1.2.4', 'a patch is the default step');
  assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(nextVersion('junk'), null);

  assert.equal(classifyChange(['fix']), 'patch');
  assert.equal(classifyChange(['docs', 'test']), 'patch');
  assert.equal(classifyChange(['fix', 'feature']), 'minor', 'the largest kind wins');
  assert.equal(classifyChange(['feature', 'breaking']), 'major');
  assert.equal(classifyChange(['rename']), 'major');
  assert.equal(classifyChange([]), 'none', 'nothing reported, nothing recommended');
  assert.equal(classifyChange(['something-new']), 'patch', 'an unknown kind is the smallest step');
});

test('evaluateBump() refuses no step and a step backwards, and accepts one step however many things changed', () => {
  const unchanged = evaluateBump({ from: '1.2.3', to: '1.2.3', kinds: ['feature'] });
  assert.equal(unchanged.ok, false);
  assert.equal(unchanged.code, 'VERSION_UNCHANGED');
  assert.match(unchanged.guidance, /1\.3\.0/, 'the guidance names the next version to move to');

  const backwards = evaluateBump({ from: '1.2.3', to: '1.2.2' });
  assert.equal(backwards.ok, false);
  assert.equal(backwards.code, 'VERSION_BACKWARDS');

  const invalid = evaluateBump({ from: '1.2.3', to: 'junk' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'VERSION_INVALID');

  // The rule's whole point: one step is enough, and the size of the session is a note.
  const small = evaluateBump({ from: '1.2.3', to: '1.2.4', kinds: ['fix'] });
  assert.equal(small.ok, true);
  assert.equal(small.distance, 'patch');
  assert.equal(small.understated, false);

  const understated = evaluateBump({ from: '1.2.3', to: '1.2.4', kinds: ['feature', 'breaking'] });
  assert.equal(understated.ok, true, 'a single step is accepted however many things changed');
  assert.equal(understated.code, 'VERSION_BUMPED');
  assert.equal(understated.recommended, 'major');
  assert.equal(understated.understated, true, 'and it is reported as a note');
  assert.match(understated.message, /One step is enough/);

  const generous = evaluateBump({ from: '1.2.3', to: '2.0.0', kinds: ['fix'] });
  assert.equal(generous.ok, true);
  assert.equal(generous.understated, false, 'a larger step than needed is never a note');
});

test('applyBump() rewrites the manifest and both lockfile versions together, verified', () => {
  const dir = tempProject({ version: '1.2.3' });

  const report = applyBump({ dir, to: '1.3.0' });
  assert.deepEqual({ from: report.from, to: report.to, distance: report.distance }, {
    from: '1.2.3',
    to: '1.3.0',
    distance: 'minor',
  });

  assert.equal(readJson(dir, 'package.json').version, '1.3.0');
  const lock = readJson(dir, 'package-lock.json');
  // npm reads both places, so a lockfile that disagrees with the manifest is a broken
  // install for whoever runs `npm ci`.
  assert.equal(lock.version, '1.3.0', 'the top-level lockfile version moved too');
  assert.equal(lock.packages[''].version, '1.3.0', 'and the root package entry with it');
  assert.equal(lock.lockfileVersion, 3, 'the rest of the lockfile is untouched');

  // The file on disk is the canonical shape npm writes: two spaces, one trailing newline.
  const text = fs.readFileSync(path.join(dir, 'package.json'), 'utf-8');
  assert.ok(text.endsWith('}\n'), 'the manifest keeps its trailing newline');
  assert.match(text, /\n {2}"name": "moncho-cli",\n/);

  assert.throws(() => applyBump({ dir, to: '1.3.0' }), /already 1\.3\.0/);
  assert.throws(() => applyBump({ dir, to: '1.2.0' }), /never reused/);
  assert.throws(() => applyBump({ dir, to: 'nope' }), /not a semver/);

  // A stripped tree with no lockfile still bumps, because the manifest is the source.
  const bare = tempProject({ version: '2.0.0', lock: false });
  applyBump({ dir: bare, to: '2.0.1' });
  assert.equal(readJson(bare, 'package.json').version, '2.0.1');
  assert.equal(fs.existsSync(path.join(bare, 'package-lock.json')), false, 'no lockfile is invented');
});

test('checkBump() compares the manifest with the last release tag instead of a remembered number', () => {
  const dir = tempProject({ version: '1.3.0' });

  const ahead = checkBump({ dir, tag: 'v1.2.3' });
  assert.equal(ahead.ok, true);
  assert.equal(ahead.code, 'VERSION_BUMPED');
  assert.equal(ahead.tag, 'v1.2.3');

  const stuck = checkBump({ dir: tempProject({ version: '1.2.3' }), tag: 'v1.2.3' });
  assert.equal(stuck.ok, false);
  assert.equal(stuck.code, 'VERSION_UNCHANGED');

  const behind = checkBump({ dir: tempProject({ version: '1.0.0' }), tag: 'v1.2.3' });
  assert.equal(behind.ok, false);
  assert.equal(behind.code, 'VERSION_BACKWARDS');

  // Nothing tagged yet: the first release declares where it starts, and passes.
  const untagged = checkBump({ dir, tag: null });
  assert.equal(untagged.ok, true);
  assert.equal(untagged.code, 'NO_RELEASE_YET');
});

test('the manifest and the lockfile carry the same version, so npm ci installs what the tag names', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf-8'));

  assert.ok(parseSemver(manifest.version), 'package.json#version must be a semver');
  assert.equal(lock.version, manifest.version, 'the lockfile top-level version must agree');
  assert.equal(lock.packages[''].version, manifest.version, 'and its root package entry');
  assert.equal(lock.packages[''].name, manifest.name, 'and the name it installs under');
});

test('the maintainer guide states the rule, and names the command that carries it out', () => {
  const guide = fs.readFileSync(path.join(root, 'CONTRIBUTING.md'), 'utf-8');

  assert.match(guide, /Bump the version before you finish/, 'the rule needs its own section');
  assert.match(
    guide,
    /one step is enough even when the session\s+changed many things/,
    'the guide must state that one step is enough'
  );
  assert.match(guide, /scripts\/bump-version\.mjs --minor/, 'and name the command that does it');
  assert.match(guide, /package-lock\.json/, 'and say the lockfile moves with the manifest');
  assert.match(guide, /docs\/maintainer\/version-bump\//, 'and point at the spec');
});

test('the bump stays a maintainer affair, so the shipped prompt never mentions it', () => {
  // config/prompt.md is not a document of this repository: it is the system prompt of
  // every install (scripts/install.sh copies it into ~/.config/moncho-cli, and
  // bin/lib/image.sh bakes it into moncho-agent), so the session reading it usually
  // stands in a user's project. A bump rule there is advice about a tree it is not in,
  // and on a Node project it would edit a version with nothing to do with this release.
  const prompt = fs.readFileSync(path.join(root, 'config', 'prompt.md'), 'utf-8');

  assert.doesNotMatch(prompt, /bump/i, 'the prompt stays out of the release bookkeeping');
  assert.doesNotMatch(prompt, /package\.json#version/, 'and never names the number');
});

test('the release check refuses a manifest that never moved past the last tag', () => {
  // The release script is the backstop: a forgotten bump surfaces there, not in the
  // contents of a tag. It reaches the arithmetic rather than re-implementing it.
  const release = fs.readFileSync(path.join(root, 'scripts', 'release.mjs'), 'utf-8');
  assert.match(release, /import \{ bumpDistance \} from '\.\.\/utils\/version-bump\.js'/);
  assert.match(release, /'the manifest moved past the last release'/, 'the check must be named');
  assert.match(release, /distance !== 'none' && distance !== 'backwards'/, 'and refuse both ways');

  // The rule it enforces, on the numbers the repository really carries: the last tag is
  // v0.1.1, so the current manifest has to be ahead of it.
  assert.equal(bumpDistance('0.1.1', '0.2.0'), 'minor');
  assert.notEqual(bumpDistance('0.1.1', '0.1.1'), 'patch');
});
