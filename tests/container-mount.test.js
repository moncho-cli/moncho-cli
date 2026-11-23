import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * The container's mount boundary (docs/agent/host-fence).
 *
 * The workspace is bind-mounted read-write, so a write inside the container lands on the
 * host's checkout. Two paths there are *executed* by the host — a git hook (and the config
 * that redirects the hook directory) and the env file the runner sources — so the runner
 * shadows each with a read-only mount of its own. A nested mount wins over its parent, which
 * is what makes the shadow work.
 *
 * `build_run_args()` is a shell function in `bin/lib/container.sh`, so the suite sources the
 * real library and reads the array it builds: nothing here is a copy of the logic. No docker
 * daemon is involved — the arguments are decided before `docker run` is ever called.
 */

const root = path.resolve(import.meta.dirname, '..');
const library = path.join(root, 'bin/lib/container.sh');
// `build_run_args()` ends by calling `build_env_flags()`, which lives in env.sh — the
// runner sources both in this order (`bin/moncho-cli`), so the suite does too.
const envLibrary = path.join(root, 'bin/lib/env.sh');

/** Run a bash snippet that sources the real library and prints the args it built. */
function runArgs(snippet, { workspace, files = {}, home } = {}) {
  const dir = workspace ?? fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-mount-'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf-8');
  }
  const script = [
    'set -euo pipefail',
    'log() { :; }',
    'die() { printf "DIE %s\\n" "$*" >&2; exit 1; }',
    'warn() { :; }',
    `WORKSPACE=${JSON.stringify(dir)}`,
    `MONCHO_HOME=${JSON.stringify(home ?? '')}`,
    'CONTAINER_NAME=moncho-test',
    'STATE_VOLUME=moncho-state-test',
    'MOUNT_MODE=bind',
    'STATE_MODE=volume',
    'PROJECT_IMAGE=moncho-test:latest',
    'ENV_FLAGS=()',
    `source ${JSON.stringify(envLibrary)}`,
    `source ${JSON.stringify(library)}`,
    'build_run_args',
    'printf "%s\\n" "${RUN_ARGS[@]}"',
    snippet,
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8', cwd: dir });
  return { dir, args: result.stdout.split('\n').filter(Boolean), status: result.status, stderr: result.stderr };
}

test('a git repository and an env file are shadowed read-only', () => {
  const { args } = runArgs('', {
    files: { '.git/config': '[core]\n', '.env.moncho': 'OPENAI_MODEL=x\n' },
  });
  const gitMount = args.find((arg) => arg.endsWith(':/app/.git:ro'));
  const envMount = args.find((arg) => arg.endsWith(':/app/.env.moncho:ro'));
  assert.ok(gitMount, `expected a read-only .git mount, got:\n${args.join('\n')}`);
  assert.ok(envMount, `expected a read-only .env.moncho mount, got:\n${args.join('\n')}`);
  assert.ok(gitMount.startsWith('/'), 'the mount names an absolute host path');
  assert.ok(envMount.startsWith('/'), 'the mount names an absolute host path');
});

test('the workspace stays read-write and the shadow mounts are nested inside it', () => {
  const { dir, args } = runArgs('', {
    files: { '.git/config': '[core]\n', '.env.moncho': 'A=1\n' },
  });
  // The parent mount is what makes the checkout live; the shadows are nested within it.
  assert.ok(args.includes(`${dir}:/app`), 'the workspace is mounted read-write');
  assert.ok(args.includes(`${dir}/.git:/app/.git:ro`), 'the shadow is nested under /app');
  assert.ok(args.includes(`${dir}/.env.moncho:/app/.env.moncho:ro`), 'the shadow is nested under /app');
  // A nested mount must come after its parent for docker to layer it on top.
  assert.ok(args.indexOf(`${dir}:/app`) < args.indexOf(`${dir}/.git:/app/.git:ro`));
});

test('git never takes its optional index lock inside the container', () => {
  const { args } = runArgs('');
  assert.ok(args.includes('GIT_OPTIONAL_LOCKS=0'), 'a read-only .git must not be asked to lock');
});

test('a workspace with no .git or env file gets no shadow mount', () => {
  const { args } = runArgs('');
  assert.ok(!args.some((arg) => arg.endsWith(':ro') && arg.includes('.git')), 'no .git to shadow');
  assert.ok(!args.some((arg) => arg.endsWith('.env.moncho:ro')), 'no env file to shadow');
  // The flag is unconditional: it is harmless and keeps the mount the boundary either way.
  assert.ok(args.includes('GIT_OPTIONAL_LOCKS=0'));
});

test('the installed payload is mounted read-only over the agent runtime', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-home-'));
  fs.writeFileSync(path.join(home, 'main.js'), '// the agent\n');
  const { args } = runArgs('', { home });

  const payloadMount = args.find((arg) => arg.endsWith(':/opt/moncho-cli:ro'));
  assert.ok(payloadMount, `expected a read-only payload mount, got:\n${args.join('\n')}`);
  assert.equal(payloadMount, `${home}:/opt/moncho-cli:ro`, 'the mount names the installed payload');
  // node_modules is the one part the agent may write, so an anonymous volume lets the
  // image's copy win — the same trick /app/node_modules uses.
  assert.ok(args.includes('/opt/moncho-cli/node_modules'), 'node_modules is a writable volume');
});

test('a payload that is not installed is not mounted', () => {
  // MONCHO_HOME set but no main.js: docker would create a *directory* at the mount
  // point, which is worse than no mount at all.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-home-empty-'));
  const { args } = runArgs('', { home: empty });
  assert.ok(!args.some((arg) => arg.includes('/opt/moncho-cli')), 'nothing to shadow, nothing mounted');
});

/**
 * Drive `sync_back()` with a stub `docker` on PATH. The stub answers `ps -aq` with a
 * container name and `cp` by copying a fixture tree, so the function's own logic — the
 * staging copy and the `agent/` removal — runs for real without a daemon.
 */
function runSyncBack({ delete: withDelete = false, rsync = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-sync-'));
  const bin = path.join(dir, 'bin');
  const workspace = path.join(dir, 'workspace');
  const source = path.join(dir, 'source');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  // What the container's /app holds: a project file and the mounted state volume.
  fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  fs.writeFileSync(path.join(source, 'src/app.js'), 'export const x = 1;\n');
  fs.mkdirSync(path.join(source, 'agent/sessions/abc'), { recursive: true });
  fs.writeFileSync(path.join(source, 'agent/sessions/abc/context.json'), '{"raw":true}\n');

  // A stub docker: `ps -aq` names a container, `cp <name>:<path> <dest>` copies the fixture.
  // A stub docker: `ps -aq` names a container, `cp <name>:<path> <dest>` copies the fixture.
  // A host path is not a container path, so the staging-to-workspace step is a real `cp`.
  const stub = [
    '#!/bin/bash',
    'case "$1" in',
    '  ps) printf "fake-container\\n" ;;',
    '  cp) shift; src="$1"; dest="$2";',
    '      case "$src" in',
    '        *:/app/.) cp -a "$SOURCE/." "$dest" ;;',
    '        *) printf "docker cp needs a container path: %s\\n" "$src" >&2; exit 1 ;;',
    '      esac ;;',
    'esac',
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'docker'), stub, { mode: 0o755 });
  if (rsync) {
    fs.writeFileSync(path.join(bin, 'rsync'), '#!/bin/bash\nshift; shift\ncp -a "$1/." "$2/"\n', { mode: 0o755 });
  }

  const script = [
    'set -euo pipefail',
    'log() { :; }',
    'die() { printf "DIE %s\\n" "$*" >&2; exit 1; }',
    'warn() { :; }',
    `WORKSPACE=${JSON.stringify(workspace)}`,
    'CONTAINER_NAME=moncho-test',
    'STATE_VOLUME=moncho-state-test',
    `SYNC_DELETE=${withDelete ? '1' : '0'}`,
    'MOUNT_MODE=bind',
    'STATE_MODE=volume',
    'PROJECT_IMAGE=moncho-test',
    'ENV_FLAGS=()',
    `source ${JSON.stringify(envLibrary)}`,
    `source ${JSON.stringify(library)}`,
    'sync_back',
  ].join('\n');

  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf-8',
    cwd: workspace,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SOURCE: source },
  });
  return { dir, workspace, result };
}

test('sync_back never copies the agent state back to the host', () => {
  const { workspace, result } = runSyncBack();
  assert.equal(result.status, 0, result.stderr);
  // The project file arrives; the mounted state volume does not.
  assert.ok(fs.existsSync(path.join(workspace, 'src/app.js')), 'the project file is copied back');
  assert.ok(!fs.existsSync(path.join(workspace, 'agent')), 'agent/ never reaches the host');
});

test('the --sync-delete path excludes agent/ too', () => {
  const { workspace, result } = runSyncBack({ delete: true, rsync: true });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(workspace, 'src/app.js')), 'the project file is copied back');
  assert.ok(!fs.existsSync(path.join(workspace, 'agent')), 'agent/ never reaches the host');
});

test('copy mode mounts nothing at all, so there is nothing to shadow', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-mount-'));
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const script = [
    'set -euo pipefail',
    'log() { :; }',
    'die() { printf "DIE %s\\n" "$*" >&2; exit 1; }',
    'warn() { :; }',
    `WORKSPACE=${JSON.stringify(dir)}`,
    'CONTAINER_NAME=moncho-test',
    'STATE_VOLUME=moncho-state-test',
    'MOUNT_MODE=copy',
    'STATE_MODE=volume',
    'PROJECT_IMAGE=moncho-test:latest',
    'ENV_FLAGS=()',
    `source ${JSON.stringify(envLibrary)}`,
    `source ${JSON.stringify(library)}`,
    'build_run_args',
    'printf "%s\\n" "${RUN_ARGS[@]}"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8', cwd: dir });
  const args = result.stdout.split('\n').filter(Boolean);
  assert.ok(!args.some((arg) => arg.includes(':/app/.git')), 'copy mode mounts no workspace');
  assert.ok(args.includes('GIT_OPTIONAL_LOCKS=0'));
});
