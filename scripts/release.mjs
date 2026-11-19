#!/usr/bin/env node
// Prepare a release: derive the tag from the manifest, prove the documents quote the
// same repository, and print the URLs the install really uses.
//
//   node scripts/release.mjs                  # check the next release
//   node scripts/release.mjs --version 0.2.0  # check a planned bump
//   node scripts/release.mjs --stage          # also stage the payload
//
// The tag is *declared*, never discovered. `package.json#version` is the single source,
// the tag is `v<version>`, and the script refuses to continue when the repository
// already carries that name: a release published twice under one tag is a broken
// install for whoever fetched it in between.
//
// It also checks the one thing a tag cannot fix on its own — that the README and the
// installer name the same repository the tag lives in. A wrong URL is not a version
// mistake, it is a 404, and no amount of tagging repairs it.
//
// Exit codes: 0 ready to publish, 1 a check failed.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The repository the install really downloads from. One place, so the URL cannot drift. */
const REPO = 'moncho-cli/moncho-cli';
const REPO_URL = `https://github.com/${REPO}`;

const USAGE = `Usage: node scripts/release.mjs [options]

Options:
  --version <x.y.z>   check a planned bump instead of the manifest version
  --tag <ref>         override the derived tag (default: v<version>)
  --ref <ref>         the branch the README install line tracks (default: main)
  --stage             also stage the distribution payload (agent/utils/probe-payload.mjs)
  --offline           skip the remote tag lookup
  -h, --help          this text

Nothing is tagged, committed or pushed by this script. It checks and it prints.`;

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1] ?? null;
};
const flag = (name) => args.includes(name);

if (flag('-h') || flag('--help')) {
  console.log(USAGE);
  process.exit(0);
}

const failures = [];
const warnings = [];

const pass = (name, detail = '') =>
  console.log(`ok    ${name}${detail ? `\n        ${detail}` : ''}`);
const fail = (name, detail = '') => {
  failures.push(name);
  console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
};
const warn = (name, detail = '') => {
  warnings.push(name);
  console.log(`warn  ${name}${detail ? `\n        ${detail}` : ''}`);
};
const check = (name, condition, detail = '') => {
  if (condition) pass(name, detail);
  else fail(name, detail);
};

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf-8');

/** Run git and return its stdout, or null when it fails (no repo, no network). */
const git = (...argv) => {
  try {
    return execFileSync('git', argv, {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    }).trim();
  } catch {
    return null;
  }
};

const manifest = JSON.parse(read('package.json'));
const version = option('--version') || manifest.version;
const tag = option('--tag') || `v${version}`;
const ref = option('--ref') || 'main';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

console.log(`Release check for ${REPO_URL}`);
console.log(`  manifest version  ${manifest.version}`);
console.log(`  planned tag       ${tag}`);
console.log(`  README ref        ${ref}`);
console.log('');

// 1. The tag is a well-formed name derived from the manifest.
check('the version is a semver', SEMVER.test(version), version);
if (option('--tag') && tag !== `v${version}`) {
  warn('the tag does not name the manifest version', `${tag} vs v${version}`);
} else {
  check('the tag is the manifest version with a v', tag === `v${version}`, tag);
}
check('the tag is not a branch name', tag !== 'main' && tag !== 'master', tag);

// 2. Nothing already carries it — the question the release cannot answer by itself.
const localTags = (git('tag', '-l') || '').split('\n').filter(Boolean);
const previous = (git('tag', '-l', '--sort=-v:refname') || '').split('\n').filter(Boolean)[0];
check(
  'no local tag carries the name',
  !localTags.includes(tag),
  previous ? `previous release: ${previous}` : 'no release yet'
);

if (flag('--offline')) {
  warn('the remote tag lookup was skipped', '--offline');
} else {
  const remote = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`);
  if (remote === null) warn('the remote tag lookup failed', 'no network, or no origin remote');
  else check('no remote tag carries the name', remote === '', tag);
}

// 3. The commit a tag would point at.
const head = git('rev-parse', '--short', 'HEAD');
const dirty = git('status', '--porcelain');
if (dirty === null) {
  warn('the git state could not be read', 'not a repository?');
} else if (dirty !== '') {
  warn(
    'the working tree is not clean',
    `${dirty.split('\n').length} path(s) uncommitted — a tag points at a commit, not at these edits`
  );
} else {
  pass('the working tree is clean', head ? `HEAD ${head}` : '');
}

// 4. The documents name the same repository the tag lives in.
const readme = read('README.md');
const installer = read('scripts/install.sh');

const installLines = readme.split('\n').filter((line) => line.includes('raw.githubusercontent.com'));
check('the README quotes an install URL', installLines.length > 0, installLines[0]?.trim() ?? '');
check(
  'that URL names this repository',
  installLines.length > 0 && installLines.every((line) => line.includes(`/${REPO}/`)),
  `expected /${REPO}/ in the URL`
);
check('no placeholder is left in the README', !/<org>|<repo>/.test(readme));

const expectedRepo = 'REPO="${MONCHO_REPO:-' + REPO + '}"';
check('the installer defaults to this repository', installer.includes(expectedRepo), expectedRepo);
check('the installer header quotes this repository', installer.includes(`githubusercontent.com/${REPO}/`));
check('no placeholder is left in the installer', !/<org>|<repo>/.test(installer));

// 5. Optionally prove the payload still stages cleanly at this version.
if (flag('--stage')) {
  const probe = path.join(root, 'agent/utils/probe-payload.mjs');
  if (!fs.existsSync(probe)) {
    warn('the payload probe is not in this checkout', `${probe} is a maintainer tool and does not ship`);
  } else try {
    execFileSync(process.execPath, [path.join(root, 'agent/utils/probe-payload.mjs'), version], {
      cwd: root,
      stdio: 'inherit',
    });
    pass('the payload stages cleanly', `build/payload at ${version}`);
  } catch {
    fail('the payload stages cleanly', 'agent/utils/probe-payload.mjs reported a problem');
  }
}

// 6. The URLs. A ref that is not main/master is fetched as a *tag* by the installer,
// so the tag really does have to exist on the remote before either URL resolves.
const scriptUrl = `https://raw.githubusercontent.com/${REPO}/${ref}/scripts/install.sh`;
const pinnedScriptUrl = `https://raw.githubusercontent.com/${REPO}/${tag}/scripts/install.sh`;
const tarballUrl = `https://github.com/${REPO}/archive/refs/tags/${tag}.tar.gz`;

warn(
  'the installer checksum check cannot fire for an archive URL',
  `it looks for ${tarballUrl}.sha256, which GitHub's archive endpoint does not publish; a Release asset would`
);

console.log('');
console.log('URLs the install uses');
console.log(`  script (tracks ${ref})  ${scriptUrl}`);
console.log(`  script (pinned)         ${pinnedScriptUrl}`);
console.log(`  tarball                 ${tarballUrl}`);
console.log('');
console.log('To publish');
console.log(`  git add -A && git commit -m "Release ${tag}"`);
console.log(`  git tag -a ${tag} -m "Release ${tag}"`);
console.log(`  git push origin HEAD ${tag}`);
console.log('');
console.log('Then prove the URLs are live');
console.log(`  curl -fsSI ${tarballUrl}`);
console.log(`  curl -fsSL ${pinnedScriptUrl} | head -n 1`);

if (warnings.length > 0) {
  console.log('');
  console.log(`${warnings.length} warning(s):`);
  for (const name of warnings) console.log(`  - ${name}`);
}

if (failures.length > 0) {
  console.log('');
  console.log(`${failures.length} check(s) failed:`);
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}

console.log('');
console.log('All checks passed. Nothing has been tagged or pushed.');
