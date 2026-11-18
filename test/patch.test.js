import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyPatch, applyPatchToString } from '../utils/patch_lib.js';
import { execute as patchFileExecute } from '../tools/patch_file.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-patch-test-'));
process.chdir(root);

function writeFile(name, content) {
  fs.mkdirSync(path.dirname(name), { recursive: true });
  fs.writeFileSync(name, content, 'utf-8');
}

function readFile(name) {
  return fs.readFileSync(name, 'utf-8');
}

function diff(relativePath, oldStart, oldLen, newStart, newLen, body) {
  return [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`,
    ...body
  ].join('\n');
}

test('consecutive added lines keep their order (regression)', () => {
  writeFile('order.js', 'alpha\nold\nomega\n');
  const patch = diff('order.js', 1, 3, 1, 4, [
    ' alpha', '-old', '+NEW_A', '+NEW_B', ' omega'
  ]);

  const result = applyPatch(patch, 'order.js');

  assert.equal(readFile('order.js'), 'alpha\nNEW_A\nNEW_B\nomega\n');
  assert.equal(result.status, 'success');
  assert.equal(result.verification.readbackMatches, true);
  assert.equal(result.verification.oldSideMatched, true);
  assert.equal(result.verification.independentApplyMatches, true);
});

test('multiple hunks are applied in file order', () => {
  const original = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
  writeFile('multi.txt', original);
  const patch = [
    '--- a/multi.txt',
    '+++ b/multi.txt',
    '@@ -1,3 +1,3 @@',
    ' l1', '-l2', '+L2', ' l3',
    '@@ -8,3 +8,3 @@',
    ' l8', '-l9', '+L9', ' l10'
  ].join('\n');

  applyPatch(patch, 'multi.txt');

  const expected = Array.from({ length: 10 }, (_, i) => (i === 1 ? 'L2' : i === 8 ? 'L9' : `l${i + 1}`)).join('\n') + '\n';
  assert.equal(readFile('multi.txt'), expected);
});

test('blank context line without a leading space is accepted', () => {
  writeFile('blank.js', 'const fs = require("fs");\nconst process = require("process");\n\nconst model = "llama3";\n');
  const patch = diff('blank.js', 1, 4, 1, 5, [
    ' const fs = require("fs");',
    '+const readline = require("readline");',
    ' const process = require("process");',
    '', // intentionally empty instead of ' '
    ' const model = "llama3";'
  ]);

  const result = applyPatch(patch, 'blank.js');

  assert.equal(
    readFile('blank.js'),
    'const fs = require("fs");\nconst readline = require("readline");\nconst process = require("process");\n\nconst model = "llama3";\n'
  );
  assert.equal(result.verification.readbackMatches, true);
});

test('a new file can be created from /dev/null', () => {
  const patch = [
    '--- /dev/null',
    '+++ b/new.js',
    '@@ -0,0 +1,3 @@',
    '+line1', '+line2', '+line3'
  ].join('\n');

  applyPatch(patch, 'new.js');

  assert.equal(readFile('new.js'), 'line1\nline2\nline3\n');
});

test('a hunk can append at end of file', () => {
  writeFile('append.txt', 'a\nb\n');
  applyPatch(diff('append.txt', 2, 0, 3, 1, ['+c']), 'append.txt');
  assert.equal(readFile('append.txt'), 'a\nb\nc\n');
});

test('deletion-only hunk', () => {
  writeFile('delete.txt', 'a\nb\nc\n');
  applyPatch(diff('delete.txt', 1, 3, 1, 2, [' a', '-b', ' c']), 'delete.txt');
  assert.equal(readFile('delete.txt'), 'a\nc\n');
});

test('CRLF line endings are preserved', () => {
  writeFile('crlf.txt', 'a\r\nb\r\n');
  applyPatch(diff('crlf.txt', 1, 2, 1, 3, [' a', ' b', '+c']), 'crlf.txt');
  assert.equal(readFile('crlf.txt'), 'a\r\nb\r\nc\r\n');
});

test('no-newline-at-EOF marker is honored', () => {
  writeFile('nonl.txt', 'a\nb');
  const patch = [
    '--- a/nonl.txt',
    '+++ b/nonl.txt',
    '@@ -2 +2 @@',
    '-b',
    '+B',
    '\\ No newline at end of file'
  ].join('\n');

  applyPatch(patch, 'nonl.txt');

  assert.equal(readFile('nonl.txt'), 'a\nB');
});

test('line-number drift is handled within the fuzzy window', () => {
  const original = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
  writeFile('drift.txt', original);
  const patch = diff('drift.txt', 4, 3, 4, 3, [' l11', '-l12', '+L12', ' l13']);

  const result = applyPatch(patch, 'drift.txt');

  assert.ok(readFile('drift.txt').includes('L12\n'));
  assert.equal(result.verification.hunks[0].lineDrift, 7);
});

test('hunk count mismatch is rejected and the file is unchanged', () => {
  writeFile('counts.txt', 'a\nb\n');
  const patch = diff('counts.txt', 1, 2, 1, 3, [' a', '+b']);

  assert.throws(
    () => applyPatch(patch, 'counts.txt'),
    (error) => error.code === 'HUNK_COUNT_MISMATCH'
  );
  assert.equal(readFile('counts.txt'), 'a\nb\n');
});

test('context mismatch is reported with the first mismatching line and leaves the file unchanged', () => {
  writeFile('mismatch.txt', 'a\nb\nc\n');
  const patch = diff('mismatch.txt', 1, 3, 1, 3, [' a', '-X', '+Y', ' c']);

  assert.throws(
    () => applyPatch(patch, 'mismatch.txt'),
    (error) => {
      assert.equal(error.code, 'HUNK_MISMATCH');
      assert.deepEqual(error.details.firstMismatch, { line: 2, expected: 'X', actual: 'b' });
      return true;
    }
  );
  assert.equal(readFile('mismatch.txt'), 'a\nb\nc\n');
});

test('a failing later hunk prevents any earlier hunk from being written', () => {
  const original = Array.from({ length: 6 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
  writeFile('rollback.txt', original);
  const patch = [
    '--- a/rollback.txt',
    '+++ b/rollback.txt',
    '@@ -1,3 +1,3 @@',
    ' l1', '-l2', '+L2', ' l3',
    '@@ -4,3 +4,3 @@',
    ' l4', '-NOPE', '+X', ' l6'
  ].join('\n');

  assert.throws(() => applyPatch(patch, 'rollback.txt'), (error) => error.code === 'HUNK_MISMATCH');
  assert.equal(readFile('rollback.txt'), original);
});

test('path traversal is rejected', () => {
  const outside = path.join(path.dirname(root), 'moncho-should-not-exist.txt');
  const patch = diff('safe.txt', 1, 1, 1, 2, [' a', '+b']);

  assert.throws(() => applyPatch(patch, '../moncho-should-not-exist.txt'), (error) => error.code === 'INVALID_PATH');
  assert.equal(fs.existsSync(outside), false);
});

test('a +++ header that disagrees with the path argument is rejected', () => {
  writeFile('header.txt', 'a\n');
  const patch = [
    '--- a/header.txt',
    '+++ b/other.txt',
    '@@ -1 +1 @@',
    '-a', '+b'
  ].join('\n');

  assert.throws(() => applyPatch(patch, 'header.txt'), (error) => error.code === 'PATH_MISMATCH');
  assert.equal(readFile('header.txt'), 'a\n');
});

test('patches touching multiple files are rejected', () => {
  writeFile('one.txt', 'a\n');
  const patch = [
    '--- a/one.txt',
    '+++ b/one.txt',
    '@@ -1 +1 @@',
    '-a', '+b',
    '',
    '--- a/two.txt',
    '+++ b/two.txt',
    '@@ -1 +1 @@',
    '-x', '+y'
  ].join('\n');

  assert.throws(() => applyPatch(patch, 'one.txt'), (error) => error.code === 'MULTIPLE_FILES');
  assert.equal(readFile('one.txt'), 'a\n');
});

test('patch_file tool returns a structured success/error JSON contract', async () => {
  writeFile('tool.txt', 'a\nb\n');
  const good = diff('tool.txt', 1, 2, 1, 2, [' a', '-b', '+B']);

  const ok = JSON.parse(await patchFileExecute({ path: 'tool.txt', patchStr: good }));
  assert.equal(ok.status, 'success');
  assert.equal(ok.verification.readbackMatches, true);
  assert.equal(readFile('tool.txt'), 'a\nB\n');

  const bad = diff('tool.txt', 1, 2, 1, 2, [' a', '-Z', '+Y']);
  const failed = JSON.parse(await patchFileExecute({ path: 'tool.txt', patchStr: bad }));
  assert.equal(failed.status, 'error');
  assert.equal(failed.code, 'HUNK_MISMATCH');
  assert.equal(readFile('tool.txt'), 'a\nB\n');
});

test('applyPatchToString applies a patch without touching the filesystem', () => {
  const patch = diff('memory.txt', 1, 1, 1, 2, [' x', '+y']);
  assert.equal(applyPatchToString('x\n', patch), 'x\ny\n');
});

test('wrong-context patch is rejected with HUNK_MISMATCH and leaves the file unchanged', () => {
  writeFile('wrongctx.txt', 'alpha\nbeta\ngamma\n');
  // Context line "NOT_IN_FILE" does not exist, so no hunk can be fitted.
  const patch = diff('wrongctx.txt', 1, 3, 1, 3, [' alpha', '-NOT_IN_FILE', '+CHANGED', ' gamma']);

  assert.throws(
    () => applyPatch(patch, 'wrongctx.txt'),
    (error) => error.code === 'HUNK_MISMATCH'
  );
  assert.equal(readFile('wrongctx.txt'), 'alpha\nbeta\ngamma\n');
});

test('a git-style multi-file patch is rejected with MULTIPLE_FILES', () => {
  writeFile('gitone.txt', 'a\n');
  const patch = [
    'diff --git a/gitone.txt b/gitone.txt',
    'index 0000000..1111111 100644',
    '--- a/gitone.txt',
    '+++ b/gitone.txt',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/gittwo.txt b/gittwo.txt',
    'index 0000000..2222222 100644',
    '--- a/gittwo.txt',
    '+++ b/gittwo.txt',
    '@@ -1 +1 @@',
    '-x',
    '+y'
  ].join('\n');

  assert.throws(
    () => applyPatch(patch, 'gitone.txt'),
    (error) => error.code === 'MULTIPLE_FILES'
  );
  assert.equal(readFile('gitone.txt'), 'a\n');
});

test('a patch missing the +++ header is rejected as INVALID_PATCH', () => {
  writeFile('noheader.txt', 'a\n');
  const patch = ['--- a/noheader.txt', '@@ -1 +1 @@', '-a', '+b'].join('\n');

  assert.throws(
    () => applyPatch(patch, 'noheader.txt'),
    (error) => error.code === 'INVALID_PATCH'
  );
  assert.equal(readFile('noheader.txt'), 'a\n');
});
