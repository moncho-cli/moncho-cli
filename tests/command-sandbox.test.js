import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execute as runBashExecute, validateCommand, tokenizeCommand } from '../tools/run_bash.js';
import { validateNpmArgs, splitNpmArgs } from '../tools/run_npm.js';
import { resolveCommandPalette, paletteIsConfigured } from '../utils/command-palette.js';
import { ALLOWED_COMMANDS } from '../config/constants.js';

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

test('resolveCommandPalette keeps the defaults when nothing usable is configured', () => {
  // Unset, empty and separator-only are all the same answer: unset. A value that parses to
  // nothing must NOT become an empty palette, because "no commands at all" looks exactly
  // like a broken sandbox and nothing in the refusal would say which it was.
  for (const nothing of [undefined, null, '', '   ', ',', ' , , ', '\t\n']) {
    assert.deepEqual(resolveCommandPalette(nothing, ALLOWED_COMMANDS), ALLOWED_COMMANDS);
  }
  // A configured value that drops entirely (every name unusable) keeps the defaults too.
  assert.deepEqual(resolveCommandPalette('/bin/sh,../bin/bash', ALLOWED_COMMANDS), ALLOWED_COMMANDS);
});

test('resolveCommandPalette reads a comma-separated and a space-separated list', () => {
  assert.deepEqual(resolveCommandPalette('ls,cat,git', ALLOWED_COMMANDS), ['ls', 'cat', 'git']);
  assert.deepEqual(resolveCommandPalette('ls cat git', ALLOWED_COMMANDS), ['ls', 'cat', 'git']);
  // Both separators at once, with the surrounding whitespace of a hand-written list.
  assert.deepEqual(resolveCommandPalette(' ls, cat  git ,wc ', ALLOWED_COMMANDS), ['ls', 'cat', 'git', 'wc']);
  // An array is accepted as well, so a caller need not join it first.
  assert.deepEqual(resolveCommandPalette(['ls', 'cat'], ALLOWED_COMMANDS), ['ls', 'cat']);
  // Order is kept and a repeat is dropped, so the palette a caller reads is the one it wrote.
  assert.deepEqual(resolveCommandPalette('git,ls,git', ALLOWED_COMMANDS), ['git', 'ls']);
});

test('resolveCommandPalette drops a name that could not be a first token', () => {
  // The palette is matched against the first token of a tokenised command line, so a name
  // with a slash, a space or a metacharacter could never be matched there. Keeping it would
  // be a knob that pretends to work; dropping it is a knob that honestly does nothing.
  assert.deepEqual(resolveCommandPalette('ls,/bin/sh', ALLOWED_COMMANDS), ['ls']);
  assert.deepEqual(resolveCommandPalette('ls,..,a/b', ALLOWED_COMMANDS), ['ls']);
  assert.deepEqual(resolveCommandPalette('ls,;rm', ALLOWED_COMMANDS), ['ls']);
  // Real binary punctuation survives: `python3.11`, `g++`, `node-20`, `my_tool`.
  assert.deepEqual(resolveCommandPalette('python3.11,g++,node-20,my_tool', ALLOWED_COMMANDS),
    ['python3.11', 'g++', 'node-20', 'my_tool']);
});

test('resolveCommandPalette never answers an empty palette, whatever it is given', () => {
  // The property, stated once and checked over the whole space of plausible inputs: an
  // empty palette is never a valid answer, because it is the one value that would silently
  // disable the agent's whole command surface.
  const inputs = [undefined, null, '', ',', ' ', '/a/b', ';;;', [], ['/a'], ['', '  ']];
  for (const input of inputs) {
    const resolved = resolveCommandPalette(input, ALLOWED_COMMANDS);
    assert.ok(resolved.length > 0, `an empty palette for ${JSON.stringify(input)}`);
    assert.deepEqual(resolved, ALLOWED_COMMANDS);
  }
});

test('paletteIsConfigured distinguishes the defaults from a configured palette', () => {
  // The two questions a caller has — "what are the names" and "did somebody set this" —
  // are answered from one resolver, so they cannot drift apart.
  assert.equal(paletteIsConfigured(undefined, ALLOWED_COMMANDS), false);
  assert.equal(paletteIsConfigured('', ALLOWED_COMMANDS), false);
  assert.equal(paletteIsConfigured('/bin/sh', ALLOWED_COMMANDS), false);
  assert.equal(paletteIsConfigured('ls', ALLOWED_COMMANDS), true);
  assert.equal(paletteIsConfigured(ALLOWED_COMMANDS.join(','), ALLOWED_COMMANDS), false,
    'naming the defaults explicitly is still the defaults');
});

test('run_bash rejects a binary the configured palette omits and accepts one it adds', () => {
  // Driven through `validateCommand`'s own parameter rather than the environment, so the
  // case proves the *rule* without depending on how the value arrives.
  const narrowed = resolveCommandPalette('ls,cat', ALLOWED_COMMANDS);
  assert.deepEqual(validateCommand('ls -la', narrowed), ['ls', '-la']);
  assert.throws(() => validateCommand('git status', narrowed), (e) => e.code === 'COMMAND_NOT_ALLOWED');

  const widened = resolveCommandPalette('ls,make', ALLOWED_COMMANDS);
  assert.deepEqual(validateCommand('make test', widened), ['make', 'test']);
  assert.throws(() => validateCommand('git status', widened), (e) => e.code === 'COMMAND_NOT_ALLOWED');
});

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
