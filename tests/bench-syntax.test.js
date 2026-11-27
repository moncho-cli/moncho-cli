import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * The bench framework, guarded against being broken by accident.
 *
 * `bench/` is *outside* the three realms on purpose (bench/README.md, "Why this is a
 * separate thing"): the bench measures the agent, so it must not be part of it, and the
 * agent's installer never ships it. The price of that separation is that none of the
 * project's usual guards reach it — not the docs realm, not the lint, not a unit suite.
 * Three thousand lines of shell could be edited into a syntax error and every existing
 * suite would stay green, which is the failure this file exists to catch.
 *
 * It checks the two things that break in that order:
 *
 *  1. **It still parses and still hangs together.** Every script passes `bash -n`; the
 *     JavaScript helper and the shell templates `init` copies parse too; every library
 *     sources on its own under the `set -euo pipefail` the entry point runs with; every
 *     path a script sources at run time exists; every `kind_*` the dispatcher calls is
 *     defined by the kind; the commands the parser accepts, the usage text prints, the
 *     README lists and the case block dispatches are one set; and the installer still
 *     stages the framework whole while excluding `docs/` and `tests/`.
 *
 *  2. **It still runs on the host.** `init`, `status`, `explain`, `help` and `versions`
 *     need no docker and no network, so a scratch bench is made and described for real —
 *     the difference between "the shell parses" and "the shell works".
 *
 * What it deliberately cannot check is a *rollout*: `build`, `select`, `run`, `grade`
 * and `shell` need docker, a reachable daemon and the network, which a unit suite must
 * not require. Those stay the maintainer's to run; this file keeps them reachable.
 */

const root = path.resolve(import.meta.dirname, '..');
const benchDir = path.join(root, 'bench');
const entry = path.join(benchDir, 'bench.sh');

const read = (file) => fs.readFileSync(file, 'utf-8');
const rel = (file) => path.relative(root, file).split(path.sep).join('/');

/** Every shell script under bench/, at any depth. */
function benchScripts() {
  const found = [];
  const walk = (dir) => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) walk(full);
      else if (dirent.name.endsWith('.sh')) found.push(full);
    }
  };
  walk(benchDir);
  return found.sort();
}

/** Run the real entry point. `env` is passed verbatim when given, so a test can keep an
 *  ambient provider variable out of the run and assert on output it controls. */
function runBench(args, { cwd = benchDir, env = process.env } = {}) {
  const result = spawnSync('bash', [entry, ...args], { cwd, env, encoding: 'utf-8' });
  return { status: result.status, out: result.stdout || '', err: result.stderr || '' };
}

/** A scratch directory a test owns and removes when it ends. */
function scratchDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A minimal, deterministic environment: no provider, no ambient framework install. */
const bareEnv = (dir) => ({
  PATH: process.env.PATH,
  HOME: dir,
  TMPDIR: dir,
  MONCHO_BENCH_HOME: path.join(dir, 'home'),
  TZ: 'UTC',
});

/** POSIX single-quoting, so a path with a space or a quote survives being embedded. */
const shellQuote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;

// ---------------------------------------------------------------------------
// It still parses
// ---------------------------------------------------------------------------

test('every bench shell script parses under bash -n', () => {
  const scripts = benchScripts();
  assert.ok(scripts.length >= 10, `expected the bench framework, found ${scripts.length} scripts`);
  for (const name of ['bench.sh', 'install.sh', 'lib/common.sh', 'kinds/swe/kind.sh']) {
    assert.ok(scripts.includes(path.join(benchDir, name)), `bench/${name} is missing`);
  }
  for (const script of scripts) {
    const check = spawnSync('bash', ['-n', script], { encoding: 'utf-8' });
    assert.equal(check.status, 0, `${rel(script)} does not parse:\n${check.stderr}`);
  }
});

test('the dataset helper parses as JavaScript', () => {
  const helper = path.join(benchDir, 'kinds/swe/dataset.mjs');
  assert.ok(fs.existsSync(helper), 'the swe kind has no dataset.mjs');
  const check = spawnSync(process.execPath, ['--check', helper], { encoding: 'utf-8' });
  assert.equal(check.status, 0, `bench/kinds/swe/dataset.mjs does not parse:\n${check.stderr}`);
});

test('the kind templates are valid shell, since the framework sources them', () => {
  // `init` copies these verbatim into a bench, and the framework then *sources* both the
  // Benchfile and .env.bench — so a template that is not valid shell is a bench that
  // cannot be loaded, authored by the tool that was supposed to make one.
  for (const name of ['Benchfile', 'env.bench']) {
    const file = path.join(benchDir, 'kinds/swe/templates', name);
    assert.ok(fs.existsSync(file), `the swe kind has no templates/${name}`);
    const check = spawnSync('bash', ['-n', file], { encoding: 'utf-8' });
    assert.equal(check.status, 0, `bench/kinds/swe/templates/${name} does not parse:\n${check.stderr}`);
  }
});

// ---------------------------------------------------------------------------
// It still hangs together
// ---------------------------------------------------------------------------

test('every bench shell script opens with the bash shebang', () => {
  for (const script of benchScripts()) {
    assert.match(
      read(script).split('\n')[0], /^#!\/usr\/bin\/env bash$/,
      `${rel(script)} does not open with the bash shebang`
    );
  }
});

test('every library sources standalone under the entry point shell options', () => {
  const libDir = path.join(benchDir, 'lib');
  const libs = fs.readdirSync(libDir).filter((name) => name.endsWith('.sh')).sort();
  assert.ok(libs.length >= 5, `expected the bench libraries, found ${libs.length}`);

  for (const name of libs) {
    const file = path.join(libDir, name);
    // SCRIPT_DIR is what the entry point sets before it sources anything, so a library
    // that reads it at load time is exercising exactly the contract it is handed.
    const script = [
      'set -euo pipefail',
      `SCRIPT_DIR=${shellQuote(benchDir)}`,
      `. ${shellQuote(file)}`,
      "printf 'SOURCED-OK\\n'",
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
    assert.equal(result.status, 0, `bench/lib/${name} does not source on its own:\n${result.stderr}`);
    assert.match(result.stdout, /SOURCED-OK/, `bench/lib/${name} aborted before finishing`);
  }
});

test('every path a script sources at run time really exists', () => {
  const references = [];
  for (const script of benchScripts()) {
    for (const line of read(script).matchAll(/^\.\s+"\$SCRIPT_DIR\/([^"]+)"/gm)) {
      references.push({ from: script, target: line[1] });
    }
  }
  assert.ok(references.length >= 8, `expected the runtime sourcing, found ${references.length}`);

  for (const { from, target } of references) {
    assert.ok(fs.existsSync(path.join(benchDir, target)), `${rel(from)} sources a missing file: ${target}`);
  }
});

test('every kind_* function a script calls is defined by the kind', () => {
  // The dispatcher's contract with a kind is a set of function *names*. A call to one
  // that no kind defines is a "command not found" at run time, in a container, halfway
  // through an experiment — so it is caught here instead.
  const defined = new Set();
  const referenced = new Set();
  for (const script of benchScripts()) {
    const source = read(script);
    for (const match of source.matchAll(/^([a-zA-Z_][a-zA-Z0-9_]*)\(\)/gm)) defined.add(match[1]);
    for (const match of source.matchAll(/\bkind_[a-z0-9_]+\b/g)) referenced.add(match[0]);
  }

  assert.ok(referenced.size >= 6, `expected the kind surface, found ${referenced.size} names`);
  const missing = [...referenced].filter((name) => !defined.has(name)).sort();
  assert.deepEqual(missing, [], `kind functions are called but never defined: ${missing.join(', ')}`);
});

test('the commands accepted, dispatched, printed by usage and listed in the README are one set', () => {
  const source = read(entry);

  const alternation = source.match(/^\s*([a-z]+(?:\|[a-z]+)+)\)\s*$/m);
  assert.ok(alternation, 'bench.sh has no command alternation in parse_args');
  const accepted = [...new Set(alternation[1].split('|'))].sort();

  const heredoc = source.match(/cat <<'EOF'\n([\s\S]*?)\nEOF\n/);
  assert.ok(heredoc, 'bench.sh usage has no heredoc');
  const usage = [];
  for (const line of heredoc[1].split('\n')) {
    const row = line.match(/^ {2}([a-z]+) {2,}\S/);
    if (row) usage.push(row[1]);
  }
  const usageSet = [...new Set(usage)].sort();

  const readme = [...read(path.join(benchDir, 'README.md')).matchAll(/^moncho-cli bench ([a-z]+)/gm)]
    .map((match) => match[1]);

  const caseBlock = source.match(/case "\$COMMAND" in\n([\s\S]*?)\n {2}esac/);
  assert.ok(caseBlock, 'bench.sh has no command case block');
  const dispatched = [...caseBlock[1].matchAll(/^ {4}([a-z]+)\)/gm)].map((match) => match[1]);

  assert.ok(accepted.length >= 12, `expected the command surface, found ${accepted.length}`);
  assert.deepEqual(accepted, usageSet, 'the parser accepts a different set of commands than usage prints');
  assert.deepEqual(
    [...new Set([...readme, 'help'])].sort(), usageSet,
    'bench/README.md and the usage text list different commands'
  );

  const orphans = dispatched.filter((name) => !usageSet.includes(name));
  assert.deepEqual(orphans, [], `the dispatcher handles commands usage never mentions: ${orphans.join(', ')}`);

  // Everything is either a case arm or handled before the case block. Naming the two
  // early branches makes adding a third a deliberate edit rather than a silent one.
  const early = usageSet.filter((name) => name !== 'help' && !dispatched.includes(name));
  assert.deepEqual(early, ['init', 'versions'], 'the commands handled before the case block changed');
});

test('the installer stages the framework whole, and excludes docs and tests', () => {
  const installer = read(path.join(benchDir, 'install.sh'));
  for (const fragment of ['bench/bench.sh', 'bench/lib/.', 'bench/kinds/.']) {
    assert.ok(installer.includes(fragment), `bench/install.sh does not stage ${fragment}`);
  }
  assert.match(installer, /-name docs/, 'the installer does not exclude docs/');
  assert.match(installer, /-name tests/, 'the installer does not exclude tests/');
});

// ---------------------------------------------------------------------------
// It still runs on the host
// ---------------------------------------------------------------------------

test('init writes a bench, and status and explain describe it without docker', (t) => {
  const scratch = scratchDir(t, 'moncho-bench-suite-');
  const env = bareEnv(scratch);

  const init = runBench(['init', '--kind', 'swe', '--name', 'probe'], { cwd: scratch, env });
  assert.equal(init.status, 0, `init failed:\n${init.err}`);

  const benchfile = path.join(scratch, 'Benchfile');
  const envFile = path.join(scratch, '.env.bench');
  assert.ok(fs.existsSync(benchfile), 'init did not write a Benchfile');
  assert.ok(fs.existsSync(envFile), 'init did not write .env.bench');
  assert.match(read(benchfile), /^BENCH_NAME="probe"$/m, 'the Benchfile does not carry the name init was given');
  assert.match(read(path.join(scratch, '.gitignore')), /^\.env\.bench$/m, 'the .gitignore does not ignore the credentials file');
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600, '.env.bench holds a key and must be mode 600');

  const json = runBench(['status', '--json'], { cwd: scratch, env });
  assert.equal(json.status, 0, `status --json failed:\n${json.err}`);
  const state = JSON.parse(json.out);
  assert.equal(state.bench_name, 'probe');
  assert.equal(state.bench_kind, 'swe');
  assert.equal(state.plan_frozen, false, 'a fresh bench has no frozen plan');
  assert.equal(state.runs, 0, 'a fresh bench has no runs');

  const human = runBench(['status'], { cwd: scratch, env });
  assert.equal(human.status, 0, `status failed:\n${human.err}`);
  assert.match(human.out, /probe/, 'status does not name the bench');

  const explain = runBench(['explain', '--json'], { cwd: scratch, env });
  assert.equal(explain.status, 0, `explain --json failed:\n${explain.err}`);
  const recipe = JSON.parse(explain.out);
  assert.match(recipe.dataset, /SWE-bench/, 'explain does not name the dataset');
  assert.equal(recipe.turns, 1, 'explain does not carry the turn budget');
});

test('a directory with no Benchfile is refused, not half-read', (t) => {
  const scratch = scratchDir(t, 'moncho-bench-nofile-');
  const result = runBench(['status'], { cwd: scratch, env: bareEnv(scratch) });
  assert.equal(result.status, 1, 'a missing Benchfile must fail the command');
  assert.match(result.err, /no Benchfile/, 'the refusal does not say what is missing');
  assert.match(result.err, /bench init/, 'the refusal does not say how to make one');
});

test('help and versions answer without a bench and without docker', (t) => {
  const scratch = scratchDir(t, 'moncho-bench-help-');
  const help = runBench(['help'], { cwd: scratch, env: bareEnv(scratch) });
  assert.equal(help.status, 0, `help failed:\n${help.err}`);
  assert.match(help.out, /Usage: moncho-cli bench/, 'help does not print the usage text');

  const versions = runBench(['versions'], { cwd: scratch, env: bareEnv(scratch) });
  assert.equal(versions.status, 0, `versions failed:\n${versions.err}`);
  assert.match(versions.out, /framework/, 'versions does not name the framework');
});
