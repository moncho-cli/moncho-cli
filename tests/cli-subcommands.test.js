import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * The companion seam (docs/runtime/cli-subcommands).
 *
 * `moncho-cli <word> …` reaches `moncho-<word>` when <word> is neither a flag nor a command
 * this program implements. The seam is shell (`bin/lib/subcommand.sh`, sourced by
 * `bin/moncho-cli`), so the suite sources the real library and runs the real entry point —
 * nothing here is a copy of the rule, and no companion is needed for the parts that are
 * about the rule itself.
 *
 * What the seam must never do is claim one of this program's own invocations: a flag, a
 * built-in, or an empty command line. Each of those is a way for a companion to end up
 * running something the user asked `moncho-cli` itself to do.
 */

const root = path.resolve(import.meta.dirname, '..');
const library = path.join(root, 'bin/lib/subcommand.sh');
const cli = path.join(root, 'bin/moncho-cli');

/**
 * Source the seam library and run a snippet with it, in a caller-supplied PATH.
 *
 * `die` is stubbed to exit non-zero with its message on stderr, which is what the seam's
 * refusal does in the real program (`bin/lib/common.sh`).
 *
 * A `path` argument is *prepended* to the real PATH rather than replacing it. Replacing it
 * would take `bash` itself out of reach and every spawn would fail before the snippet ran,
 * which looks like a failing seam and is really a broken harness.
 */
function runSeam(snippet, { args = [], path: pathOverride, cwd } = {}) {
  const script = [
    'set -euo pipefail',
    'die() { printf "DIE %s\\n" "$*" >&2; exit 1; }',
    `source ${JSON.stringify(library)}`,
    snippet,
  ].join('\n');

  const result = spawnSync('bash', ['-c', script, 'seam', ...args], {
    encoding: 'utf-8',
    cwd: cwd ?? root,
    env: { ...process.env, PATH: withPrepended(pathOverride) },
  });
  return { out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim(), status: result.status };
}

/** Run the real entry point, with a PATH that may include stub companions. */
function runCli(args, { path: pathOverride, cwd } = {}) {
  const result = spawnSync('bash', [cli, ...args], {
    encoding: 'utf-8',
    cwd: cwd ?? root,
    env: { ...process.env, PATH: withPrepended(pathOverride) },
  });
  return { out: result.stdout ?? '', err: result.stderr ?? '', status: result.status };
}

/** `dir:$PATH`, or the real PATH when no directory was given. */
function withPrepended(dir) {
  return dir ? `${dir}:${process.env.PATH}` : process.env.PATH;
}

/** A directory holding one stub companion, named `moncho-<word>`. */
function stubCompanion(word, body = 'printf "RAN %s\\n" "$*"') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-sub-'));
  const file = path.join(dir, `moncho-${word}`);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return dir;
}

// --- what counts as a companion request ------------------------------------

test('a first word that is not a command is a companion request', () => {
  assert.equal(runSeam('is_external_subcommand bench && echo yes || echo no').out, 'yes');
  assert.equal(runSeam('is_external_subcommand deploy && echo yes || echo no').out, 'yes');
  // Notably not a word this program knows, but nothing else has to be true of it.
  assert.equal(runSeam('is_external_subcommand zzz-unknown-tool && echo yes || echo no').out, 'yes');
});

test('a flag is never a companion request', () => {
  // The options a user reaches for first must not be treated as tool names: `--version` is
  // this program's, and there is no `moncho---version` to look for.
  for (const flag of ['--version', '-h', '--help', '--continue', '--exec', '-y', '--']) {
    assert.equal(
      runSeam(`is_external_subcommand ${JSON.stringify(flag)} && echo yes || echo no`).out,
      'no',
      `${flag} must stay this program's own`
    );
  }
});

test('a built-in command is never a companion request', () => {
  // So a companion can never shadow a command: `moncho-cli build` means what it always
  // meant even on a machine with `moncho-build` installed.
  for (const word of ['run', 'start', 'stop', 'shell', 'build', 'status', 'uninstall', 'help']) {
    assert.equal(
      runSeam(`is_external_subcommand ${word} && echo yes || echo no`).out,
      'no',
      `${word} is this program's command`
    );
  }
});

test('an empty first word is not a companion request', () => {
  // A quoted empty string is a real first word, and it names no tool.
  assert.equal(runSeam('is_external_subcommand "" && echo yes || echo no').out, 'no');
});

test('no first word at all is not a companion request', () => {
  // Bare `moncho-cli` is `run`; it must not become a hunt for `moncho-`.
  assert.equal(runSeam('is_external_subcommand && echo yes || echo no').out, 'no');
});

// --- the name, and resolution ----------------------------------------------

test('the companion a word names is moncho-word', () => {
  assert.equal(runSeam('external_subcommand_name bench').out, 'moncho-bench');
  assert.equal(runSeam('external_subcommand_name deploy').out, 'moncho-deploy');
});

test('resolution finds an executable on PATH', () => {
  const dir = stubCompanion('bench');
  const found = runSeam('external_subcommand_path moncho-bench', { path: dir });
  assert.equal(found.status, 0);
  assert.equal(found.out, path.join(dir, 'moncho-bench'));
});

test('resolution refuses a file that exists but is not executable', () => {
  // `command -v` answers for a non-executable file, and `exec` on one fails with a message
  // about permissions — which sends a reader looking at the wrong thing. The seam checks
  // the executable bit instead, so the refusal that follows can name the real problem.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-noexec-'));
  fs.writeFileSync(path.join(dir, 'moncho-bench'), '#!/bin/sh\necho nope\n', { mode: 0o644 });
  const result = runSeam('external_subcommand_path moncho-bench && echo found || echo missing', { path: dir });
  assert.equal(result.out, 'missing');
});

test('resolution refuses a name that is not on PATH', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-empty-'));
  const result = runSeam('external_subcommand_path moncho-bench && echo found || echo missing', { path: empty });
  assert.equal(result.out, 'missing');
  assert.equal(result.status, 0, 'the refusal is an exit status, not a crash');
});

// --- the hand-over, through the real entry point ----------------------------

test('moncho-cli hands the rest of the command line over verbatim', () => {
  // A hand-over, not a parse: the companion receives every argument after its own name,
  // untouched and in order, so its flags can never collide with this program's.
  const dir = stubCompanion('bench', 'printf "ARGS:"; for a in "$@"; do printf " [%s]" "$a"; done; printf "\\n"');
  const result = runCli(['bench', 'run', '--instances', 'a,b', '--json', '-x'], { path: dir });
  assert.equal(result.status, 0, result.err);
  assert.equal(result.out.trim(), 'ARGS: [run] [--instances] [a,b] [--json] [-x]');
});

test("a companion's exit status is the invocation's exit status", () => {
  // A caller scripting `moncho-cli bench run` depends on the failure surviving the seam.
  const dir = stubCompanion('bench', 'exit 7');
  assert.equal(runCli(['bench'], { path: dir }).status, 7);

  const ok = stubCompanion('bench', 'exit 0');
  assert.equal(runCli(['bench'], { path: ok }).status, 0);
});

test('a missing companion is refused, naming the moncho-word it looked for', () => {
  // The word *was* recognised as a companion request, so "unknown command" would be wrong:
  // it would suggest this program might have owned it.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-none-'));
  const result = runCli(['bench', 'build'], { path: empty });
  assert.notEqual(result.status, 0, 'a missing companion is a failure');
  assert.match(result.err, /moncho-bench/, 'the refusal names the program it looked for');
  assert.match(result.err, /not a command moncho-cli implements/, 'it says what the word was not');
  assert.doesNotMatch(result.err, /unknown command/, 'never "unknown command"');
});

test('the seam is reached before the workspace and the env file are resolved', () => {
  // A companion has its own idea of what a workspace is: a bench is a directory of its own,
  // and `moncho-cli bench init` must work in one whose git repository this program would
  // refuse. So the hand-over happens before the repository gate and before any env file.
  const dir = stubCompanion('bench', 'printf "RAN-IN:%s\\n" "$PWD"');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-notgit-'));

  // The directory is deliberately not a git repository, and there is no env file. If the
  // seam were reached later, the run would stop at the gate instead of the companion.
  const result = runCli(['bench', 'init'], { path: dir, cwd: bare });
  assert.equal(result.status, 0, `the companion must run in a non-repository: ${result.err}`);
  assert.match(result.out, /RAN-IN:/, 'the companion ran');
  assert.doesNotMatch(result.err, /git repository/i, 'the repository gate was not reached');
});

test('moncho-cli still runs its own commands with a companion on PATH', () => {
  // The seam must not swallow an invocation this program owns. `help` is the cheapest
  // built-in to observe, and a `moncho-help` on PATH is the trap for a greedy seam.
  const dir = stubCompanion('help', 'printf "WRONG: the companion ran\\n"');
  const result = runCli(['help'], { path: dir });
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /Usage: moncho-cli/, 'moncho-cli printed its own usage');
  assert.doesNotMatch(result.out, /WRONG/, 'the companion did not run');

  // And a flag with a companion named after it: `--version` is never a tool lookup.
  const flag = runCli(['--version'], { path: dir });
  assert.doesNotMatch(flag.out, /WRONG/, 'a flag never reaches the seam');
});
