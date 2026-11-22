import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { definition as editDefinition, execute as editFile } from '../tools/edit_file.js';
import { clearReads, recordRead } from '../utils/read-tracker.js';

/**
 * `edit_file` as a tool: the rails around the engine (docs/agent/line-edits).
 *
 * The pure rules — literal matching, the diagnostics behind a miss — are stated in
 * `tests/edit-engine.test.js`. What is left here is everything that touches a file, which
 * is exactly what `edit_file` has to get right by sharing it with the other writers: the
 * sandbox, the staleness guard, the tracking fence, the verified write and the structured
 * response.
 *
 * The two error classes that dominated `patch_file` (`INVALID_PATCH_LINE`,
 * `HUNK_COUNT_MISMATCH`) cannot be expressed by this tool at all; what is proved here is
 * that the refusals it *does* raise leave the file untouched and name the fix.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-edit-test-'));
process.chdir(root);

/** The JSON body of a tool result. */
const body = (result) => JSON.parse(String(result));

function writeFile(name, content) {
  fs.mkdirSync(path.dirname(name), { recursive: true });
  fs.writeFileSync(name, content, 'utf-8');
}

function readFile(name) {
  return fs.readFileSync(name, 'utf-8');
}

test('model-facing edit criteria match no-change refusals', async () => {
  const params = editDefinition.function.parameters.properties;
  assert.match(params.replace.description, /must differ from "search"/);
  assert.match(params.edits.description, /non-empty and differ from replace/);
  assert.match(params.edits.description, /final result must change/);
  writeFile('no-change.txt', 'one');
  const same = body(await editFile({ path: 'no-change.txt', search: 'one', replace: 'one' }));
  assert.equal(same.code, 'NO_CHANGES');
  const reversed = body(await editFile({ path: 'no-change.txt', edits: [
    { search: 'one', replace: 'two' }, { search: 'two', replace: 'one' },
  ] }));
  assert.equal(reversed.code, 'NO_CHANGES');
  assert.equal(readFile('no-change.txt'), 'one');
});

test('an edit replaces exactly the searched text and leaves the rest alone', async () => {
  writeFile('simple.js', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');

  const result = body(await editFile({
    intent: 'change b',
    path: 'simple.js',
    search: 'const b = 2;',
    replace: 'const b = 20;',
  }));

  assert.equal(result.status, 'success');
  assert.equal(result.editsApplied, 1);
  assert.equal(result.replacements, 1);
  assert.equal(readFile('simple.js'), 'const a = 1;\nconst b = 20;\nconst c = 3;\n');
});

test('a search that does not appear is refused with the nearest candidates and the source', async () => {
  writeFile('miss.js', 'const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\n');

  const result = body(await editFile({
    intent: 'change a line that is not there',
    path: 'miss.js',
    search: 'const delta = 4;',
    replace: 'const delta = 5;',
  }));

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'SEARCH_NOT_FOUND');
  assert.ok(Array.isArray(result.candidates) && result.candidates.length > 0);

  // The evidence that saves the extra round (backlog item 65): the file's own numbered
  // bytes, so the next call can be built without a re-read.
  assert.equal(typeof result.source, 'string');
  assert.ok(result.source.includes('const beta = 2;'), 'the source is what is on disk');
  assert.ok(!result.source.includes('const delta'), 'and never the text that failed');
  assert.equal(result.sourceFrom, 1);
  assert.ok(Number.isInteger(result.sourceTo));
  assert.match(result.retry, /do not retry/);
  assert.equal(/read_file is only needed/.test(result.guidance), true, 'reading back is the fallback, not the default');

  assert.equal(readFile('miss.js'), 'const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\n');
});

test('a search matching several times is refused with every line', async () => {
  writeFile('twice.js', 'run();\nother();\nrun();\n');

  const result = body(await editFile({
    intent: 'replace a call that appears twice',
    path: 'twice.js',
    search: 'run();',
    replace: 'stop();',
  }));

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'SEARCH_NOT_UNIQUE');
  assert.deepEqual(result.occurrences, [{ line: 1 }, { line: 3 }]);
  assert.equal(result.guidance.includes('"all": true'), true);
  assert.equal(readFile('twice.js'), 'run();\nother();\nrun();\n');
});

test('all: true replaces every occurrence', async () => {
  writeFile('all.js', 'run();\nother();\nrun();\n');

  const result = body(await editFile({
    intent: 'replace every call',
    path: 'all.js',
    search: 'run();',
    replace: 'stop();',
    all: true,
  }));

  assert.equal(result.status, 'success');
  assert.equal(result.replacements, 2);
  assert.equal(readFile('all.js'), 'stop();\nother();\nstop();\n');
});

test('several edits are applied in order', async () => {
  writeFile('steps.js', 'first\nsecond\n');

  const result = body(await editFile({
    intent: 'two ordered edits',
    path: 'steps.js',
    edits: [
      { search: 'first', replace: 'FIRST' },
      // Matches only because the edit above already ran: order is meaningful.
      { search: 'FIRST\nsecond', replace: 'FIRST\nSECOND' },
    ],
  }));

  assert.equal(result.status, 'success');
  assert.equal(result.editsApplied, 2);
  assert.deepEqual(result.edits.map((entry) => entry.editIndex), [1, 2]);
  assert.equal(readFile('steps.js'), 'FIRST\nSECOND\n');
});

test('a failing edit means nothing is written', async () => {
  const original = 'alpha\nbeta\n';
  writeFile('atomic.js', original);

  const result = body(await editFile({
    intent: 'a batch whose second edit cannot match',
    path: 'atomic.js',
    edits: [
      { search: 'alpha', replace: 'ALPHA' },
      { search: 'nope', replace: 'NOPE' },
    ],
  }));

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'SEARCH_NOT_FOUND');
  assert.equal(result.editIndex, 2);
  assert.equal(result.editsInBatch, 2);
  assert.equal(readFile('atomic.js'), original, 'the first edit was not written either');
});

test('both the edits array and a search/replace pair are accepted, never both', async () => {
  writeFile('shape.js', 'one\n');

  const both = body(await editFile({
    intent: 'mix the two shapes',
    path: 'shape.js',
    search: 'one',
    replace: 'two',
    edits: [{ search: 'one', replace: 'two' }],
  }));
  assert.equal(both.code, 'INVALID_ARGUMENTS');

  const neither = body(await editFile({ intent: 'send nothing to match', path: 'shape.js' }));
  assert.equal(neither.code, 'INVALID_ARGUMENTS');
  assert.equal(neither.status, 'error');
});

test('CRLF line endings are preserved', async () => {
  writeFile('crlf.txt', 'alpha\r\nbeta\r\ngamma\r\n');

  const result = body(await editFile({
    intent: 'edit a CRLF file with an LF search',
    path: 'crlf.txt',
    search: 'beta',
    replace: 'BETA',
  }));

  assert.equal(result.status, 'success');
  assert.equal(result.crlf, true);
  assert.equal(readFile('crlf.txt'), 'alpha\r\nBETA\r\ngamma\r\n');
});

test('a file that does not exist is refused with FILE_NOT_FOUND', async () => {
  const result = body(await editFile({
    intent: 'edit a file that is not there',
    path: 'ghost.js',
    search: 'x',
    replace: 'y',
  }));
  assert.equal(result.code, 'FILE_NOT_FOUND');
  assert.equal(result.guidance.includes('write_file'), true);
});

test('path traversal is rejected', async () => {
  const result = body(await editFile({
    intent: 'escape the project directory',
    path: '../outside.js',
    search: 'x',
    replace: 'y',
  }));
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'INVALID_PATH');
});

test('the tracking files are refused with the tool that owns them', async () => {
  writeFile('agent/sessions/s1/task.md', '- [ ] something\n');
  const result = body(await editFile({
    intent: 'edit the tracking file directly',
    path: 'agent/sessions/s1/task.md',
    search: '- [ ] something',
    replace: '- [x] something',
  }));
  assert.equal(result.code, 'TRACKING_FILE_TOOL_OWNED');
  assert.equal(result.message.includes('update_task'), true);
  assert.equal(readFile('agent/sessions/s1/task.md'), '- [ ] something\n');
});

test('a file changed since it was read is refused with STALE_READ', async () => {
  clearReads();
  writeFile('stale.js', 'const x = 1;\n');
  recordRead('stale.js');
  // Someone else touched the file after the read.
  fs.writeFileSync('stale.js', 'const x = 1;\nconst y = 2;\n', 'utf-8');

  const result = body(await editFile({
    intent: 'edit against bytes that moved',
    path: 'stale.js',
    search: 'const x = 1;',
    replace: 'const x = 10;',
  }));

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'STALE_READ');
  assert.equal(readFile('stale.js'), 'const x = 1;\nconst y = 2;\n');
  clearReads();
});

test('the tool returns a structured success/error JSON contract', async () => {
  writeFile('contract.txt', 'hello\n');

  const ok = body(await editFile({
    intent: 'prove the success shape',
    path: 'contract.txt',
    search: 'hello',
    replace: 'goodbye',
  }));
  assert.equal(ok.status, 'success');
  assert.equal(typeof ok.path, 'string');
  assert.equal(ok.verification.readbackMatches, true);
  assert.equal(typeof ok.message, 'string');

  const bad = body(await editFile({
    intent: 'prove the error shape',
    path: 'contract.txt',
    search: 'absent',
    replace: 'x',
  }));
  assert.equal(bad.status, 'error');
  assert.equal(typeof bad.code, 'string');
  assert.equal(typeof bad.message, 'string');
});
test('a pasted diff is applied verbatim, and refused when it does not fit', async () => {
  writeFile('pasted.txt', 'a\nb\n');

  // The user pasted this; the model only forwards it.
  const ok = body(await editFile({
    intent: 'apply the diff the user pasted',
    path: 'pasted.txt',
    patchStr: '--- a/pasted.txt\n+++ b/pasted.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n',
  }));
  assert.equal(ok.status, 'success');
  assert.equal(ok.mode, 'patch');
  assert.equal(ok.hunksApplied, 1);
  assert.equal(readFile('pasted.txt'), 'a\nB\n');

  // A diff whose header counts disagree with its own body is malformed as *input*.
  const bad = body(await editFile({
    intent: 'apply a malformed pasted diff',
    path: 'pasted.txt',
    patchStr: '--- a/pasted.txt\n+++ b/pasted.txt\n@@ -1,2 +1,3 @@\n a\n+B\n',
  }));
  assert.equal(bad.status, 'error');
  // Which parse-level code fires depends on how the counts go wrong; all of them are
  // reports about the diff the caller supplied, never a hint to regenerate it.
  assert.ok(
    ['HUNK_COUNT_MISMATCH', 'INVALID_PATCH_LINE', 'INVALID_PATCH'].includes(bad.code),
    `a malformed diff answers with a parse-level code, got ${bad.code}`,
  );
  assert.equal(typeof bad.guidance, 'string', 'the caller is told what to fix in the diff');
  assert.equal(readFile('pasted.txt'), 'a\nB\n', 'a refused diff changes nothing');
});

test('the pasted-diff branch and a search/replace edit are never mixed', async () => {
  writeFile('mixed.txt', 'one\n');

  const both = body(await editFile({
    intent: 'send a diff and a search at once',
    path: 'mixed.txt',
    search: 'one',
    replace: 'two',
    patchStr: '--- a/mixed.txt\n+++ b/mixed.txt\n@@ -1 +1 @@\n-one\n+two\n',
  }));
  assert.equal(both.code, 'INVALID_ARGUMENTS');
  assert.equal(readFile('mixed.txt'), 'one\n');
});
