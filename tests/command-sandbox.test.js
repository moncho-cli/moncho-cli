import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execute as runBashExecute, validateCommand, tokenizeCommand } from '../tools/run_bash.js';
import { validateNpmArgs, splitNpmArgs } from '../tools/run_npm.js';

/**
 * The command sandbox (docs/agent/command-sandbox): what may run, what is refused, and
 * how a result is reported.
 *
 * Split out of tests/harness-tools.test.js so each suite stays small: this file owns the
 * sandbox rules (the allow-list, the shell-free refusals, the output document) while the
 * harness suite keeps the tool contract and the context machinery.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-sandbox-test-'));
process.chdir(root);

function writeFile(name, content) {
  fs.mkdirSync(path.dirname(name), { recursive: true });
  fs.writeFileSync(name, content, 'utf-8');
}

test('run_bash rejects shell metacharacters and non-approved binaries', () => {
  assert.throws(() => validateCommand('ls; rm -rf /'), (e) => e.code === 'SHELL_METACHARACTER');
  assert.throws(() => validateCommand('cat a.txt | grep x'), (e) => e.code === 'SHELL_METACHARACTER');
  assert.throws(() => validateCommand('echo hi > out.txt'), (e) => e.code === 'SHELL_METACHARACTER');
  assert.throws(() => validateCommand('echo `whoami`'), (e) => e.code === 'SHELL_METACHARACTER');
  assert.throws(() => validateCommand('node --check a.js && node main.js'), (e) => e.code === 'SHELL_METACHARACTER');
  assert.throws(() => validateCommand('rm -rf /'), (e) => e.code === 'COMMAND_NOT_ALLOWED');
  assert.throws(() => validateCommand('   '), (e) => e.code === 'EMPTY_COMMAND');
  assert.throws(() => validateCommand('echo "unbalanced'), (e) => e.code === 'UNBALANCED_QUOTE');
});

test('run_bash keeps quoted glob patterns usable', () => {
  assert.deepEqual(validateCommand('ls "test/**/*.test.js"'), ['ls', 'test/**/*.test.js']);
  assert.deepEqual(tokenizeCommand('grep -n "a b" file.js'), ['grep', '-n', 'a b', 'file.js']);
});

test('run_bash executes an approved command and reports failures structurally', async () => {
  writeFile('ls-target.txt', 'x');
  const ok = await runBashExecute({ command: 'ls ls-target.txt', intent: 'list fixture' });

  // A success is a document: the YAML header, the delimiter, then the stdout. The
  // header and the payload are separated by a `---` line, never by a blank one.
  const lines = ok.split('\n');
  const delimiter = lines.indexOf('---');
  assert.equal(delimiter, 8, 'the header is closed by a --- line');
  assert.equal(lines[0], 'status: success');
  assert.equal(lines[1], 'command: ls ls-target.txt');
  assert.equal(lines[2], 'cwd: .');
  assert.equal(lines[3], 'exit_code: 0');
  assert.equal(lines[4], 'lines: 1');
  assert.equal(lines[5], 'shown: 1');
  assert.equal(lines[6], 'truncated: false');
  assert.equal(lines[7], 'mode: all');
  assert.equal(lines.slice(delimiter + 1).join('\n'), 'ls-target.txt');

  const blocked = JSON.parse(await runBashExecute({ command: 'ls && whoami' }));
  assert.equal(blocked.code, 'SHELL_METACHARACTER');

  const missing = JSON.parse(await runBashExecute({ command: 'cat does-not-exist.txt' }));
  assert.equal(missing.status, 'error');
  assert.equal(missing.code, 'COMMAND_FAILED');
  assert.equal(missing.mode, 'all');

  assert.ok((await runBashExecute({ command: 'pwd' })).includes(root));
});

test('run_npm validates subcommands, shell metacharacters and global installs', () => {
  assert.deepEqual(validateNpmArgs(['install', 'neo-blessed']), ['install', 'neo-blessed']);
  assert.deepEqual(validateNpmArgs('install "neo-blessed" --save'), ['install', 'neo-blessed', '--save']);
  assert.deepEqual(splitNpmArgs('ls --depth=0'), ['ls', '--depth=0']);

  assert.throws(() => validateNpmArgs(['exec', 'rm -rf /']), (e) => e.code === 'SUBCOMMAND_NOT_ALLOWED');
  assert.throws(() => validateNpmArgs(['install', 'x; rm -rf /']), (e) => e.code === 'SHELL_METACHARACTER');
  assert.throws(() => validateNpmArgs(['install', '-g', 'left-pad']), (e) => e.code === 'ARG_NOT_ALLOWED');
  assert.throws(() => validateNpmArgs(['install', '--prefix=/tmp/x', 'y']), (e) => e.code === 'ARG_NOT_ALLOWED');
  assert.throws(() => validateNpmArgs([]), (e) => e.code === 'EMPTY_ARGS');
});

test('run_npm reports a structured failure for an unknown package', async () => {
  const { execute } = await import('../tools/run_npm.js');
  const result = JSON.parse(await execute({
    args: ['view', 'moncho-package-that-does-not-exist-xyz'],
    timeoutMs: 60000,
    intent: 'verify structured npm failure'
  }));
  assert.equal(result.status, 'error');
  assert.ok(['NPM_FAILED', 'TIMEOUT'].includes(result.code));
});
