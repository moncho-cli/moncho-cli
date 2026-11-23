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
 *
 * It packs the **working tree**, not `HEAD`: the files as they are on disk mean a fix
 * under test is the one in front of you, and `make install` stays a pre-release check
 * rather than a check of the last commit. A *temporary index* is what makes that work —
 * `git add -A` into an index of its own includes the files a change just added, which
 * `git stash create` does not (it takes tracked paths only), and it never touches the
 * developer's real index.
 */
function makeArchive(base, { ref = REF, prefix = `moncho-cli-${ref}` } = {}) {
  const target = path.join(base, 'moncho-cli', 'moncho-cli', 'archive', 'refs', 'tags');
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, `${ref}.tar.gz`);

  const index = path.join(base, 'fixture.index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  // -A stages additions, edits and deletions, and respects .gitignore: `agent/` and
  // `node_modules/` stay out of the fixture exactly as they stay out of a release.
  const added = run('git', ['add', '-A'], { env });
  assert.equal(added.status, 0, `staging the fixture failed: ${added.stderr}`);
  const tree = run('git', ['write-tree'], { env });
  assert.equal(tree.status, 0, `writing the fixture tree failed: ${tree.stderr}`);

  const result = run('git', ['archive', '--format=tar.gz', `--prefix=${prefix}/`, '-o', file, tree.stdout.trim()]);
  assert.equal(result.status, 0, `git archive failed: ${result.stderr}`);
  fs.rmSync(index, { force: true });
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
function hermeticInstall({ work: existing, ref = REF, link = false } = {}) {
  const work = existing ?? fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-install-'));
  const base = path.join(work, 'archive');
  const bin = path.join(work, 'bin');
  const installDir = path.join(work, 'install');
  // Where the installer puts the symlink. It reads XDG_BIN_HOME, so this — not the stub
  // `bin/` above, which is only there to shadow curl and docker on PATH — is the seam.
  const xdgBin = path.join(work, 'local-bin');
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

  // `link` asks for the shape a real install has. The cases that only care about the
  // staged tree keep `--no-symlink`, because the link is what the two link cases test.
  const args = [installer, '--ref', ref, '--dir', installDir];
  if (!link) args.push('--no-symlink');

  const result = run('bash', args, {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      XDG_BIN_HOME: xdgBin,
      FIXTURE: path.join(base, 'moncho-cli', 'moncho-cli', 'archive', 'refs', 'tags', `${ref}.tar.gz`),
      MONCHO_ARCHIVE_BASE: `file://${base}`,
      MONCHO_REPO: 'moncho-cli/moncho-cli',
      MONCHO_REF: ref,
    },
  });
  return { work, installDir, xdgBin, linkPath: path.join(xdgBin, 'moncho-cli'), result };
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
  'a second version installs beside the first instead of replacing it',
  { skip: CAN_INSTALL_HERMETICALLY ? false : 'bash, git and tar are required to stage an archive' },
  () => {
    // Both refs are staged in one fixture, so the second run really downloads and
    // extracts a *different* payload — without that it would fail at the download and
    // prove nothing about versioned installs.
    const OTHER = 'v0.20.0';
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-install-'));
    const first = hermeticInstall({ work });
    assert.equal(first.result.status, 0, `the first install must succeed:\n${first.result.stderr}`);
    hermeticInstall({ work, ref: OTHER });

    const second = hermeticInstall({ work, ref: OTHER });
    assert.equal(second.result.status, 0, `a second version installs beside the first:\n${second.result.stderr}`);

    // The first tree is untouched and the second has one of its own: a session is pinned
    // to the version that wrote it, so replacing the older tree would make its sessions
    // unopenable (`docs/runtime/session-version`).
    assert.equal(
      fs.readFileSync(path.join(first.installDir, 'VERSION'), 'utf-8').trim(),
      REF,
      'the first version keeps its own tree'
    );
    const versioned = path.join(first.installDir, 'versions', OTHER);
    assert.ok(fs.existsSync(path.join(versioned, 'VERSION')), 'the second version has a tree of its own');
    assert.equal(fs.readFileSync(path.join(versioned, 'VERSION'), 'utf-8').trim(), OTHER);
    assert.ok(fs.existsSync(path.join(versioned, 'config/prompt.md')), 'and it is a whole payload');
  }
);

/**
 * The one shape every real install has and the staged-tree cases deliberately skip: the
 * runner is reached through `~/.local/bin/moncho-cli`, a symlink to the tree in
 * `MONCHO_HOME`. Deriving the library directory from `BASH_SOURCE[0]` there points at
 * the *link's* directory, so the runner died at its first `source` with
 * "~/.local/bin/lib/common.sh: No such file" — a failure no `--no-symlink` install could
 * ever show.
 */
test(
  'the installed runner works when reached through the ~/.local/bin symlink',
  { skip: CAN_INSTALL_HERMETICALLY ? false : 'bash, git and tar are required to stage an archive' },
  () => {
    const { work, installDir, linkPath, result } = hermeticInstall({ link: true });
    assert.equal(result.status, 0, `install.sh failed:\n${result.stderr}`);
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink(), 'the installer links the runner, it does not copy it');

    // `status` reads no daemon and writes nothing, so it is the cheapest command that
    // proves the whole preamble ran: every lib was sourced before the dispatch.
    const status = run(linkPath, ['status'], {
      cwd: work,
      env: { ...process.env, MONCHO_HOME: installDir },
    });
    assert.equal(
      status.status,
      0,
      `the linked runner must run, not fail to source its libraries:\n${status.stderr}`
    );
    assert.doesNotMatch(status.stderr, /common\.sh|No such file/i, 'a library went unfound');
    assert.match(status.stdout, new RegExp(`installed at\\s+${installDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
);

/**
 * A user who hit the broken link worked around it by writing a wrapper script at the same
 * name. `uninstall` guarded only on `-L`, so that file survived with no word said about
 * it; the tree it pointed into was deleted and the name was left behind broken.
 */
test(
  'uninstall removes a regular file at the binary name as well as the symlink',
  { skip: CAN_INSTALL_HERMETICALLY ? false : 'bash, git and tar are required to stage an archive' },
  () => {
    const { installDir, linkPath, xdgBin, result } = hermeticInstall({ link: true });
    assert.equal(result.status, 0, `install.sh failed:\n${result.stderr}`);

    // The workaround: the symlink replaced by a real file at the same name.
    fs.unlinkSync(linkPath);
    fs.writeFileSync(linkPath, '#!/bin/sh\nexec "$HOME/.config/moncho-cli/bin/moncho-cli" "$@"\n', { mode: 0o755 });

    const removed = run('bash', [installer, '--uninstall', '--dir', installDir], {
      env: { ...process.env, XDG_BIN_HOME: xdgBin, MONCHO_HOME: installDir },
    });
    assert.equal(removed.status, 0, `uninstall failed:\n${removed.stderr}`);
    assert.ok(!fs.existsSync(linkPath), 'a regular file at the binary name must be removed too');
    assert.ok(!fs.existsSync(installDir), 'the installation must be removed');

    // The state volumes hold the user's session history: named, not silently deleted.
    assert.match(removed.stdout, /moncho-state-/, 'uninstall must name the leftover state volumes');
  }
);

/**
 * The verb a user actually has: `moncho-cli uninstall`, run through the installed copy
 * itself. That is the case the installer path cannot cover — the tree being deleted is
 * the one the running script lives in, and bash reads a script incrementally, so a
 * careless `rm -rf` leaves it reading a file that no longer exists.
 */
test(
  'the installed runner uninstalls itself, without docker and without a download',
  { skip: CAN_INSTALL_HERMETICALLY ? false : 'bash, git and tar are required to stage an archive' },
  () => {
    const { work, installDir, linkPath, xdgBin, result } = hermeticInstall({ link: true });
    assert.equal(result.status, 0, `install.sh failed:\n${result.stderr}`);
    const env = { ...process.env, MONCHO_HOME: installDir, XDG_BIN_HOME: xdgBin };

    // --purge without --yes is refused *before* anything is deleted: the volumes it
    // would take are the user's session history, so consent is typed, not implied.
    const refused = run(linkPath, ['uninstall', '--purge'], { cwd: work, env });
    assert.notEqual(refused.status, 0, '--purge without --yes must refuse');
    assert.match(refused.stderr, /--yes/i, 'the refusal must say what is missing');
    assert.ok(fs.existsSync(linkPath), 'a refusal must delete nothing');
    assert.ok(fs.existsSync(installDir), 'a refusal must delete nothing');

    // The real thing. No docker is stubbed on PATH under the installer's name here, so
    // reaching the daemon at all would fail the run: the plain verb must not need it.
    const removed = run(linkPath, ['uninstall'], { cwd: work, env });
    assert.equal(removed.status, 0, `the verb must remove the installation:\n${removed.stderr}`);
    assert.ok(!fs.existsSync(linkPath), 'the PATH entry must be gone');
    assert.ok(!fs.existsSync(installDir), 'the staged tree must be gone');

    // It says what it left behind, and the command that would take it.
    assert.match(removed.stdout, /--purge/, 'the verb must name the way to remove the rest');
    assert.match(removed.stdout, /moncho-state-/, 'the verb must name the state volumes');

    // The project directory the user was standing in is not the installation.
    assert.ok(fs.existsSync(work), 'the workspace must survive an uninstall');
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