import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * The env file belongs to a flow, and each flow reads exactly one
 * (`docs/runtime/env-files`).
 *
 * Two entry points, two conventions, and the difference is *which script runs where*, not
 * who the person is:
 *
 *   * `moncho-cli` runs in **another project's** directory, so it reads `./.env.moncho` and
 *     deliberately never a generic `.env` — a project's own credentials must not become the
 *     agent's provider;
 *   * `start.sh` runs **in this checkout** (the maintainer flow), so it reads `./.env`.
 *
 * The case that motivated this file: `start.sh` carried a hand-maintained allow-list of
 * variable names, and it had drifted — `CHUNKPACTION_ENABLED` was in the maintainer's `.env`
 * and never reached the container, silently. A list that mirrors the app is a second place
 * for the env grammar to drift, so the assertions below are about the *mechanism* (the file
 * says what crosses) rather than about any particular name.
 */

const root = path.resolve(import.meta.dirname, '..');
const startSh = path.join(root, 'start.sh');
const cli = path.join(root, 'bin/moncho-cli');

/** The names a shell file assigns, read the way `bin/lib/env.sh#load_env_file` reads them. */
function declaredNames(file) {
  const text = fs.readFileSync(file, 'utf-8');
  return text
    .split('\n')
    .map((line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/))
    .filter(Boolean)
    .map((match) => match[1]);
}

test('start.sh forwards the names the env file declares, rather than a list of its own', () => {
  const script = fs.readFileSync(startSh, 'utf-8');
  // The shared rule, not a copy of it: `bin/lib/env.sh` owns sourcing, collecting names and
  // building `-e NAME`. A `-e NAME="$NAME"` line here would be the allow-list growing back.
  assert.match(script, /bin\/lib\/env\.sh/, 'it sources the shared env library');
  assert.match(script, /build_env_flags/, 'the flags are built from the file');
  assert.doesNotMatch(
    script,
    /ENV_FLAGS\+=\(-e "[A-Z_]+=\$/,
    'no per-name forwarding line, which is the list that drifted',
  );
});

test('start.sh forwards a name the old allow-list omitted, straight from ./.env', () => {
  // The regression itself, proved against the real script: a scratch copy of the checkout
  // with a `.env` holding a name the hand-list never carried, and a stub `docker` that
  // prints the argv it would run with.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-envf-'));
  fs.mkdirSync(path.join(scratch, 'bin', 'lib'), { recursive: true });
  for (const lib of ['clipboard-watch.sh', 'env.sh']) {
    fs.copyFileSync(path.join(root, 'bin', 'lib', lib), path.join(scratch, 'bin', 'lib', lib));
  }
  fs.copyFileSync(startSh, path.join(scratch, 'start.sh'));
  fs.writeFileSync(path.join(scratch, '.env'), 'OPENAI_MODEL="x"\nCHUNKPACTION_ENABLED=1\n');

  const binDir = path.join(scratch, 'stub-bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'docker'), [
    '#!/bin/sh',
    'case "$1" in',
    '  image) exit 0 ;;',
    '  run) for a in "$@"; do printf "%s\\n" "$a"; done; exit 0 ;;',
    'esac',
    'exit 0',
  ].join('\n'), { mode: 0o755 });

  const result = spawnSync('bash', [path.join(scratch, 'start.sh'), 'run'], {
    cwd: scratch,
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);

  const argv = result.stdout.split('\n');
  const flags = argv.filter((arg, index) => argv[index - 1] === '-e');
  assert.ok(flags.includes('CHUNKPACTION_ENABLED'),
    `the name from .env must reach the container, got:\n${flags.join('\n')}`);
  // `-e NAME` and not `-e NAME=value`: docker reads the value from this process, so a
  // secret never appears in the host process list.
  const shared = flags.filter((flag) => !flag.startsWith('MONCHO_MAINTAINER'));
  assert.ok(shared.every((flag) => !flag.includes('=')), 'no value is passed on the command line');
});

test('.env and .env.moncho.example declare the same settings, so neither flow is a subset', () => {
  // The maintainer's file and the user's example describe one application. A name that
  // exists in only one of them is a setting half the workspaces cannot reach.
  const maintainer = declaredNames(path.join(root, '.env.example')).sort();
  const user = declaredNames(path.join(root, '.env.moncho.example')).sort();
  const onlyMaintainer = maintainer.filter((name) => !user.includes(name));
  const onlyUser = user.filter((name) => !maintainer.includes(name));
  assert.deepEqual(onlyMaintainer, [], `missing from .env.moncho.example: ${onlyMaintainer.join(', ')}`);
  assert.deepEqual(onlyUser, [], `missing from .env.example: ${onlyUser.join(', ')}`);
});

test('every setting either example declares is one something actually reads', () => {
  // An example file that documents a name nothing reads is a promise the app does not keep.
  // `TZ` is the documented exception: no JavaScript reads it, the C library does, which is
  // what makes a stamp or a log date local. Everything else must be read by the app.
  const NOT_READ_BY_APP = new Set(['TZ']);
  const source = [
    'app', 'api', 'config', 'tools', 'utils', 'main.js',
  ].flatMap((entry) => {
    const absolute = path.join(root, entry);
    if (!fs.existsSync(absolute)) return [];
    if (fs.statSync(absolute).isFile()) return [fs.readFileSync(absolute, 'utf-8')];
    return fs.readdirSync(absolute, { recursive: true })
      .filter((name) => String(name).endsWith('.js'))
      .map((name) => fs.readFileSync(path.join(absolute, String(name)), 'utf-8'));
  }).join('\n');

  const declared = new Set([
    ...declaredNames(path.join(root, '.env.example')),
    ...declaredNames(path.join(root, '.env.moncho.example')),
  ]);
  const unread = [...declared].filter((name) => (
    !NOT_READ_BY_APP.has(name) && !source.includes(`process.env.${name}`)
  ));
  assert.deepEqual(unread, [], `declared but never read: ${unread.join(', ')}`);
});

test('each entry point names the one env file it reads, and not the other flow\'s', () => {
  // The clarity half: a maintainer must be able to tell, from the docs, which file applies.
  const usage = fs.readFileSync(path.join(root, 'USAGE.md'), 'utf-8');
  const contributing = fs.readFileSync(path.join(root, 'CONTRIBUTING.md'), 'utf-8');

  assert.match(usage, /\.env\.moncho/, 'USAGE names the user flow\'s file');
  assert.match(contributing, /\.env\b/, 'CONTRIBUTING names the maintainer flow\'s file');
  assert.match(contributing, /start\.sh/, 'CONTRIBUTING ties that file to start.sh');

  // And the runner's own help text keeps saying the same thing: the file it reads, and
  // that a generic .env is the one it does not.
  const help = spawnSync('bash', [cli, 'help'], { encoding: 'utf-8' });
  assert.match(help.stdout, /--env <path>\s+read this env file instead of \.\/\.env\.moncho/,
    'the runner documents the file it reads');
});