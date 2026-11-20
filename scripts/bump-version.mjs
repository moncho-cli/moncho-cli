#!/usr/bin/env node
// Bump the version a session leaves behind, and check that it really moved.
//
//   node scripts/bump-version.mjs --minor        # 0.2.0 -> 0.3.0, manifest + lockfile
//   node scripts/bump-version.mjs --to 1.0.0     # an explicit version
//   node scripts/bump-version.mjs --check        # did this session move it past the tag?
//
// The rule this serves (CONTRIBUTING.md): a session that changes behaviour moves
// `package.json#version`, and **one step is enough even when the
// session changed many things**. The bump marks the session, it does not measure it —
// so `--check` only refuses *no* step, never a step that understates the change.
//
// `package.json#version` is the single source of the tag: `scripts/release.mjs`
// derives `v<version>` from it. `package-lock.json` carries the same version twice,
// and a lockfile that disagrees with the manifest is a broken install for whoever
// runs `npm ci`, so both files move together here and nowhere else.
//
// Exit codes: 0 the version is in order (or was bumped), 1 a check failed.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bumpDistance, evaluateBump, nextVersion, parseSemver } from '../utils/version-bump.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MANIFEST = 'package.json';
export const LOCKFILE = 'package-lock.json';

const USAGE = `Usage: node scripts/bump-version.mjs [options]

Options:
  --to <x.y.z>   set an explicit version
  --major        step the major (a breaking change)
  --minor        step the minor (a new behaviour)
  --patch        step the patch (a fix, docs, tests) — the default
  --check        only check: the manifest must be ahead of the last release tag
  -h, --help     this text

One step is enough even when a session changed many things. Nothing is committed or
tagged: this edits the two files and prints what the release would be.`;

/** Read one JSON file under `dir`. */
function readJson(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
}

/** Write one JSON file under `dir`, verified by reading it back. */
function writeJsonVerified(dir, name, value) {
  const target = path.join(dir, name);
  const content = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(target, content, 'utf-8');
  const readback = fs.readFileSync(target, 'utf-8');
  if (readback !== content) {
    throw new Error(`${name} did not verify: the file on disk is not what was written`);
  }
  return { path: name, bytes: content.length, verified: true };
}

/**
 * The two places `package-lock.json` records the root version: the top-level `version`
 * and `packages[""].version`. Both are rewritten, because npm reads both.
 */
function withLockVersion(lock, version) {
  const next = { ...lock, version };
  if (next.packages && typeof next.packages === 'object') {
    next.packages = {
      ...next.packages,
      '': { ...(next.packages[''] || {}), version },
    };
  }
  return next;
}

/**
 * Set the version of the manifest and the lockfile in `dir`.
 *
 * @param {{dir?: string, to: string}} options
 * @returns {{from: string, to: string, distance: string, files: string[]}}
 */
export function applyBump({ dir = root, to } = {}) {
  if (!parseSemver(to)) throw new Error(`${JSON.stringify(to)} is not a semver`);
  const manifest = readJson(dir, MANIFEST);
  const from = manifest.version;
  const distance = bumpDistance(from, to);
  if (distance === 'none') throw new Error(`the version is already ${to}`);
  if (distance === 'backwards') throw new Error(`refusing to move ${from} -> ${to}: a published number is never reused`);

  writeJsonVerified(dir, MANIFEST, { ...manifest, version: to });

  // The lockfile is rewritten only when it is there: a stripped tree may not carry one.
  if (fs.existsSync(path.join(dir, LOCKFILE))) {
    const lock = readJson(dir, LOCKFILE);
    writeJsonVerified(dir, LOCKFILE, withLockVersion(lock, to));
  }

  return { from, to, distance, files: [MANIFEST, LOCKFILE] };
}

/** Run git in `dir` and return its stdout, or null when it fails. */
export function gitIn(dir, ...argv) {
  try {
    return execFileSync('git', argv, {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    }).trim();
  } catch {
    return null;
  }
}

/** The last release tag, or null when nothing is tagged (or there is no repository). */
export function lastReleaseTag(dir = root) {
  const tags = gitIn(dir, 'tag', '-l', '--sort=-v:refname');
  return tags ? tags.split('\n').filter(Boolean)[0] ?? null : null;
}

/**
 * Check the manifest against the last release tag: the session had to move it.
 *
 * `tag` is normally discovered (`lastReleaseTag()`), and may be supplied instead, so a
 * test can state the released version without a repository or a tag on disk.
 *
 * @returns {object} the `evaluateBump()` verdict, with `tag` added.
 */
export function checkBump({ dir = root, kinds = [], tag = lastReleaseTag(dir) } = {}) {
  const manifest = readJson(dir, MANIFEST);
  if (!tag) {
    return {
      ok: true,
      code: 'NO_RELEASE_YET',
      from: null,
      to: manifest.version,
      distance: null,
      recommended: 'patch',
      tag: null,
      message: 'Nothing is tagged yet, so there is no released version to move past.',
      guidance: 'The first release declares the version it starts from.',
    };
  }
  const from = tag.replace(/^v/, '');
  return { ...evaluateBump({ from, to: manifest.version, kinds }), tag };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log(USAGE);
    process.exit(0);
  }

  if (args.includes('--check')) {
    const verdict = checkBump({ kinds: args.filter((a) => a.startsWith('--kind=')).map((a) => a.slice(7)) });
    console.log(`${verdict.ok ? 'ok  ' : 'FAIL'} ${verdict.code}: ${verdict.message}`);
    if (verdict.tag) console.log(`      last release ${verdict.tag}, manifest ${verdict.to}`);
    if (!verdict.ok) {
      console.log(`      ${verdict.guidance}`);
      process.exit(1);
    }
    process.exit(0);
  }

  const explicit = args[args.indexOf('--to') + 1];
  const manifest = readJson(root, MANIFEST);
  const distance = args.includes('--major') ? 'major' : args.includes('--minor') ? 'minor' : 'patch';
  const to = args.includes('--to') && explicit ? explicit : nextVersion(manifest.version, distance);
  const kinds = args.filter((a) => a.startsWith('--kind=')).map((a) => a.slice(7));
  const verdict = evaluateBump({ from: manifest.version, to, kinds });

  const report = applyBump({ to });
  console.log(`${report.from} -> ${report.to} (${report.distance})`);
  console.log(`  ${verdict.message}`);
  console.log(`  ${report.files.join(', ')} rewritten`);
  console.log('');
  console.log('Next: node scripts/release.mjs');
}

// Importing this module (a test, a probe) must not bump anything.
if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main();
}
