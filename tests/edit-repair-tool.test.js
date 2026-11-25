import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { definition as editDefinition, execute as editFile } from '../tools/edit_file.js';
import { clearReads } from '../utils/read-tracker.js';

/**
 * A formatting-only miss is repaired by `edit_file` before it is refused (backlog item 83).
 *
 * The pure rules are `tests/edit-repair.test.js`. What is proved here is the one thing only
 * the real tool can show: the repair reaches the file, the bytes written are the file's own,
 * and the response says the search was repaired instead of reading as if it had matched.
 *
 * `docs/agent/edit-repair` is the contract these cases hold up.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-edit-repair-test-'));
process.chdir(root);

const body = (result) => JSON.parse(String(result));

function writeFile(name, content) {
  fs.writeFileSync(name, content, 'utf-8');
}

function readFile(name) {
  return fs.readFileSync(name, 'utf-8');
}

test('a search that differs only in indentation is applied and reported as repaired', async () => {
  writeFile('indent.js', 'function f() {\n  return 1;\n}\n');
  clearReads();

  const result = body(await editFile({
    intent: 'fix the return value',
    path: 'indent.js',
    search: '    return 1;',
    replace: '    return 2;',
  }));

  assert.equal(result.status, 'success');
  assert.equal(result.repaired.length, 1, 'the success names the repair it made');
  assert.equal(result.repaired[0].rule, 'indentation');
  assert.equal(result.repaired[0].line, 2);
  assert.match(result.message, /Repaired 1 search/);
  // The file holds the replacement as the model wrote it, inside the file's own line.
  assert.equal(readFile('indent.js'), 'function f() {\n    return 2;\n}\n');
});

test('a search carrying trailing whitespace the file lacks is applied, not refused', async () => {
  writeFile('trail.txt', 'alpha\nbeta\n');
  clearReads();

  const result = body(await editFile({
    intent: 'replace beta',
    path: 'trail.txt',
    search: 'beta   ',
    replace: 'BETA',
  }));

  assert.equal(result.status, 'success');
  assert.equal(result.repaired[0].rule, 'trailing-whitespace');
  assert.equal(readFile('trail.txt'), 'alpha\nBETA\n');
});

test('an exact match reports no repair at all', async () => {
  writeFile('exact.txt', 'one\ntwo\n');
  clearReads();

  const result = body(await editFile({
    intent: 'replace two',
    path: 'exact.txt',
    search: 'two',
    replace: 'three',
  }));

  assert.equal(result.status, 'success');
  assert.equal(result.repaired, undefined, 'an ordinary edit must not claim a repair');
  assert.equal(readFile('exact.txt'), 'one\nthree\n');
});

test('an ambiguous formatting match is still refused, and names every place', async () => {
  writeFile('amb.txt', 'if (a) {\n  return 1;\n}\nif (b) {\n    return 1;\n}\n');
  clearReads();

  const refused = body(await editFile({
    intent: 'replace the return',
    path: 'amb.txt',
    search: '      return 1;',
    replace: 'return 2;',
  }));

  assert.equal(refused.status, 'error');
  assert.equal(refused.code, 'SEARCH_NOT_FOUND');
  assert.deepEqual(refused.whitespaceMatches, [{ line: 2 }, { line: 5 }]);
  assert.equal(readFile('amb.txt'), 'if (a) {\n  return 1;\n}\nif (b) {\n    return 1;\n}\n');
});

test('the tool description states the repair, so the model knows a retry is not needed', () => {
  const description = editDefinition.function.description;
  assert.match(description, /line-edge whitespace/);
  assert.match(description, /repaired/);
});