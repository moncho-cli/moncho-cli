import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Installing and then building the agent, without publishing the repository.
 *
 * `scripts/install.sh` reaches the network in exactly one place: `tarball_url()`.
 * Everything after it is local — `tar -xzf`, the payload allow-list, the exclusion
 * assertion and the atomic swap — so the installer can be proved against a *tarball*
 * rather than against GitHub. `MONCHO_ARCHIVE_BASE` is that seam: the host the archive
 * is fetched from, GitHub in every real install and a `file://` directory here.
 *
 * Two cases, deliberately different in what they need:
 *
 *   * the hermetic one stubs `curl` and `docker` on PATH, so it runs anywhere and
 *     asserts what the installer *did* to a staged tree;
 *   * the build one is gated on a real daemon. It builds a dedicated container from
 *     this checkout's Dockerfile, hands it the project's own env-var names, and runs
 *     the install plus `moncho-cli build --base --base-only` inside it — the real
 *     install and the real image build.
 *
 * The gate is the point, not a weakness: dockerd needs CAP_SYS_ADMIN and a namespace
 * it can mount in. Where that is absent the case reports why and skips rather than
 * pretending a build happened.
 */

const root = path.resolve(import.meta.dirname, '..');
const installer = path.join(root, 'scripts', 'install.sh');
const REF = 'v0.21.0';

/** Run a command and return its result without throwing. */
function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf-8', cwd: root, ...options });
}

/** Whether a command exists on PATH at all. */
function has(command) {
  return run('sh', ['-c', `command -v ${command}`]).status === 0;
}

/**
 * A tarball with the one top-level directory the installer looks for, written where
 * the installer's own URL shape expects it:
 *   <base>/<repo>/archive/refs/tags/<ref>.tar.gz
 *
 * `git archive` is the same command `agent/utils/make-release.mjs` packages with, so
 * the fixture is the shape a release really has — not a hand-rolled approximation.
 */
function makeArchive(base, { ref = REF, prefix = `moncho-cli-${ref}` } = {}) {
  const target = path.join(base, 'moncho-cli', 'moncho-cli', 'archive', 'refs', 'tags');
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, `${ref}.tar.gz`);
  const result = run('git', ['archive', '--format=tar.gz', `--prefix=${prefix}/`, '-o', file, 'HEAD']);
  assert.equal(result.status, 0, `git archive failed: ${result.stderr}`);
  return { file, dir: path.dirname(file) };
}

/**
 * The env-var names the project itself declares, read the way `bin/lib/env.sh` reads
 * them: every `NAME=` assignment in the file, `export` and quoting tolerated.
 *
 * `.env.moncho.example` is the canonical list, so a name the runner passes into the
 * agent's container and a name this test passes into the build container cannot drift.
 */
function envNames() {
  const file = path.join(root, '.env.moncho.example');
  const text = fs.readFileSync(file, 'utf-8');
  const names = new Set();
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (match) names.add(match[1]);
  }
  return [...names];
}

/** The value a name carries here: the real one when exported, else a harmless stand-in. */
function envValue(name) {
  return process.env[name] ?? `probe-${name.toLowerCase()}`;
}

/** Write an executable stub into a directory. */
function stub(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

/**
 * The hermetic case: prove the install against a local archive with `curl` and
 * `docker` stubbed, so nothing about the network or a daemon is assumed.
 *
 * The stubs are minimal on purpose — they answer the two questions the installer
 * asks (`can I download this`, `is a daemon reachable`) and refuse everything else,
 * so the assertions land on the installer's own logic rather than on the stub's.
 */
function hermeticInstall({ work: existing, ref = REF } = {}) {
  const work = existing ?? fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-install-'));
  const base = path.join(work, 'archive');
  const bin = path.join(work, 'bin');
  const installDir = path.join(work, 'install');
  fs.mkdirSync(bin, { recursive: true });
  makeArchive(base, { ref });

  // `curl -fsSL <url> -o <out>`: serve the fixture for the archive, refuse the .sha256
  // so the installer takes its documented "no checksum published" branch.
  stub(
    bin,
    'curl',
    [
      'url=""; out=""',
      'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done',
      'case "$url" in',
      '  *.tar.gz) cp "$FIXTURE" "$out" ;;',
      '  *) exit 22 ;;',
      'esac',
    ].join('\n')
  );
  // The host check: `docker info` must succeed, and nothing else is asked of it here.
  stub(bin, 'docker', 'exit 0');

  const result = run('bash', [installer, '--ref', ref, '--dir', installDir, '--no-symlink'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FIXTURE: path.join(base, 'moncho-cli', 'moncho-cli', 'archive', 'refs', 'tags', `${ref}.tar.gz`),
      MONCHO_ARCHIVE_BASE: `file://${base}`,
      MONCHO_REPO: 'moncho-cli/moncho-cli',
      MONCHO_REF: ref,
    },
  });
  return { work, installDir, result };
}

const CAN_INSTALL_HERMETICALLY = has('bash') && has('git') && has('tar');

test(
  'the installer stages the payload from a local archive and needs no published repository',
  { skip: CAN_INSTALL_HERMETICALLY ? false : 'bash, git and tar are required to stage an archive' },
  () => {
    const { installDir, result } = hermeticInstall();
    assert.equal(result.status, 0, `install.sh failed:\n${result.stderr}`);

    // The version the reference names is written, not discovered.
    assert.equal(fs.readFileSync(path.join(installDir, 'VERSION'), 'utf-8').trim(), REF);

    // The runtime-only payload arrived...
    for (const expected of ['main.js', 'package.json', 'Dockerfile.agent', 'LICENSE', 'VERSION']) {
      assert.ok(fs.existsSync(path.join(installDir, expected)), `${expected} must be installed`);
    }
    assert.ok(fs.existsSync(path.join(installDir, 'bin/lib/common.sh')), 'the runner libraries must ship');
    assert.ok(fs.existsSync(path.join(installDir, 'config/prompt.md')), 'the system prompt must ship');

    // ...and the development material did not. These are the two names the installer
    // refuses to find, so their absence is the contract, not a detail.
    for (const forbidden of ['docs', 'tests', 'agent', 'node_modules', '.env', '.env.moncho']) {
      assert.ok(!fs.existsSync(path.join(installDir, forbidden)), `${forbidden} must never be installed`);
    }
  }
);

test(
  'a second install of a different reference refuses rather than overwriting',
  { skip: CAN_INSTALL_HERMETICALLY ? false : 'bash, git and tar are required to stage an archive' },
  () => {
    // Both refs are staged in one fixture, so the second run really downloads and
    // extracts a *different* payload — without that it would fail at the download and
    // prove nothing about the version check.
    const OTHER = 'v0.20.0';
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-install-'));
    const first = hermeticInstall({ work });
    assert.equal(first.result.status, 0, `the first install must succeed:\n${first.result.stderr}`);
    hermeticInstall({ work, ref: OTHER });

    const second = hermeticInstall({ work, ref: OTHER });
    assert.notEqual(second.result.status, 0, 'a second version must be refused without --force');
    assert.match(
      second.result.stderr,
      /already holds/i,
      `the refusal must name the installed version:\n${second.result.stderr}`
    );

    // The refusal is a refusal: the tree that was there is still there, untouched.
    assert.equal(
      fs.readFileSync(path.join(first.installDir, 'VERSION'), 'utf-8').trim(),
      REF,
      'a refused install must leave the existing tree untouched'
    );
    assert.ok(fs.existsSync(path.join(first.installDir, 'config/prompt.md')), 'nothing was swapped out');
  }
);

/**
 * The daemon gate. `docker info` succeeding is the only honest test of "a daemon is
 * reachable"; it is what the installer's own host check asks, so the two agree.
 */
function daemonReachable() {
  if (!has('docker')) return { ok: false, why: 'the docker CLI is not on PATH' };
  const info = run('docker', ['info']);
  if (info.status !== 0) {
    return { ok: false, why: `docker info failed: ${(info.stderr || '').trim().split('\n')[0] || 'no daemon'}` };
  }
  return { ok: true };
}

const DAEMON = daemonReachable();

test(
  'a dedicated container built from this Dockerfile installs and builds the agent',
  {
    skip: DAEMON.ok
      ? false
      : `no docker daemon (${DAEMON.why}); dockerd needs CAP_SYS_ADMIN and a mount namespace, so run this where a socket is mounted or the outer container is privileged`,
    timeout: 1_800_000,
  },
  () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-dedicated-'));
    const base = path.join(work, 'archive');
    makeArchive(base);

    // A dedicated image from this checkout, so the thing under test is the Dockerfile
    // that ships — including the docker client it is supposed to carry.
    const image = `moncho-install-probe:${Date.now()}`;
    const build = run('docker', ['build', '-t', image, '-f', path.join(root, 'Dockerfile'), root]);
    assert.equal(build.status, 0, `the dedicated image must build:\n${build.stderr}`);

    // The env vars the project declares, passed as bare `-e NAME` exactly the way
    // bin/lib/env.sh does: the value comes from this process, never from the argv.
    const names = envNames();
    const envFlags = [];
    const env = { ...process.env };
    for (const name of names) {
      env[name] = envValue(name);
      envFlags.push('-e', name);
    }

    // The install and the base-image build, inside the dedicated container. The
    // workspace is mounted so the installer under test is the checked-in one, and the
    // daemon socket is shared so `docker build` inside is a real build.
    const script = [
      'set -euo pipefail',
      'export MONCHO_ARCHIVE_BASE="file:///fixture"',
      `export MONCHO_REF="${REF}"`,
      `bash /app/scripts/install.sh --ref "${REF}" --dir /tmp/moncho-install --no-symlink`,
      'cat /tmp/moncho-install/VERSION',
      'test -f /tmp/moncho-install/config/prompt.md',
      'test ! -e /tmp/moncho-install/docs',
      'test ! -e /tmp/moncho-install/tests',
      // The build: the payload the install staged, baked into the agent base image.
      'MONCHO_HOME=/tmp/moncho-install /app/bin/moncho-cli --build-base --base-only build',
      `docker image inspect moncho-agent:${REF} >/dev/null`,
      'env',
    ].join('\n');

    const runResult = run(
      'docker',
      [
        'run',
        '--rm',
        '-u',
        `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        '-v',
        `${root}:/app:ro`,
        '-v',
        `${base}:/fixture:ro`,
        '-v',
        '/var/run/docker.sock:/var/run/docker.sock',
        '-e',
        `MONCHO_ARCHIVE_BASE=file:///fixture`,
        ...envFlags,
        image,
        'bash',
        '-c',
        script,
      ],
      { env, timeout: 1_500_000 }
    );

    assert.equal(runResult.status, 0, `the install and build must succeed:\n${runResult.stderr}`);

    // The env vars really crossed into the container: the same names the project
    // publishes, not a subset invented by the test.
    const printed = new Set(runResult.stdout.split('\n').map((line) => line.split('=')[0]));
    for (const name of ['OPENAI_BASE_URL', 'OPENAI_MODEL', 'CONTEXT_MAX_LENGTH', 'FILE_LINE_LIMIT']) {
      assert.ok(names.includes(name), `${name} must be declared by .env.moncho.example`);
      assert.ok(printed.has(name), `${name} must reach the dedicated container`);
    }
    assert.match(runResult.stdout, new RegExp(`${REF}`), 'the installed version is the ref');

    // Leave nothing behind on the daemon.
    run('docker', ['image', 'rm', '-f', image]);
  }
);