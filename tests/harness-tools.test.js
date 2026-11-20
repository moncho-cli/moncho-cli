import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadTools } from '../utils/tool-loader.js';
import { hasIntentParameter, parseToolArgs, getIntent, withIntentParameter } from '../utils/tool-schema.js';
import { execute as readFileExecute, wrapFileContent } from '../tools/read_file.js';
import { execute as writeFileExecute } from '../tools/write_file.js';
import { execute as updateTaskExecute, parseTaskItems, markItemDone, renderPlan } from '../tools/update_task.js';
import { execute as editFileExecute } from '../tools/edit_file.js';

/**
 * The tool contract and the file tools: the shared `intent` parameter, the read_file
 * delimiters, the verified atomic writes of write_file/edit_file and the task.md
 * protocol.
 *
 * The sandbox rules, the command-output document and the context machinery have their
 * own suites (tests/command-sandbox.test.js, tests/command-output-window.test.js,
 * tests/context-window.test.js); this file stays named after the contract it proves.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-harness-test-'));
process.chdir(root);

function writeFile(name, content) {
  fs.mkdirSync(path.dirname(name), { recursive: true });
  fs.writeFileSync(name, content, 'utf-8');
}

function readFile(name) {
  return fs.readFileSync(name, 'utf-8');
}

// ---------------------------------------------------------------------------
// Task.md item 6: the shared "intent" tool-call contract
// ---------------------------------------------------------------------------

test('every auto-loaded tool declares the required intent parameter', async () => {
  const { tools, toolFunctions } = await loadTools(() => {});
  assert.ok(tools.length >= 9, `expected the harness toolset, got ${tools.length}`);

  for (const tool of tools) {
    assert.ok(hasIntentParameter(tool), `${tool.function.name} is missing "intent"`);
    assert.equal(typeof toolFunctions[tool.function.name], 'function');
  }

  const names = tools.map((t) => t.function.name);
  for (const expected of ['read_file', 'hint_file', 'write_file', 'edit_file', 'run_bash', 'run_npm', 'compact_context', 'update_task', 'grep', 'blob']) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
});

test('withIntentParameter keeps the original parameters and required list', () => {
  const params = withIntentParameter({
    properties: { path: { type: 'string' } },
    required: ['path']
  });
  assert.deepEqual(Object.keys(params.properties).sort(), ['intent', 'path']);
  assert.deepEqual(params.required, ['intent', 'path']);
});

test('the loader passes the intent to the result hook', async () => {
  writeFile('intent.txt', 'hello');
  const seen = [];
  const { toolFunctions } = await loadTools((name, result, intent) => seen.push({ name, result, intent }));

  const result = await toolFunctions.read_file(JSON.stringify({ path: 'intent.txt', intent: 'check the file exists' }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'read_file');
  assert.equal(seen[0].intent, 'check the file exists');
  assert.ok(result.includes('hello'));
});

test('missing intents are surfaced instead of silently dropped', () => {
  assert.equal(getIntent(parseToolArgs('{}')), '(no intent provided)');
  assert.equal(getIntent({ intent: '  spaced   out  ' }), 'spaced out');
  assert.equal(getIntent(parseToolArgs('')), '(no intent provided)');
});

// ---------------------------------------------------------------------------
// Task.md item 7: read_file delimiters
// ---------------------------------------------------------------------------

test('read_file wraps output in <file relative_path=...> tags', async () => {
  writeFile('tagged.txt', 'one\ntwo\nthree\n');

  const result = await readFileExecute({ path: './tagged.txt', lineNumbers: false });
  assert.match(result, /^<file relative_path="tagged\.txt" from=1 to=4 lines=4>\n/);
  assert.match(result, /\n<\/file>$/);
  assert.ok(result.includes('one\ntwo\nthree\n'));
});

test('read_file reports the paged line range and total', async () => {
  writeFile('paged.txt', Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n') + '\n');

  // offset 3 is the start of line 2; limit 6 returns "l2\nl3\n" (lines 2..4 by the
  // split-on-newline convention, since the trailing newline opens an empty line 4).
  const result = await readFileExecute({ path: 'paged.txt', offset: 3, limit: 6, lineNumbers: false });
  assert.match(result, /^<file relative_path="paged\.txt" from=2 to=4 lines=3\/11>\n/);
  assert.ok(result.includes('\nl2\nl3\n'));
});

test('read_file keeps line numbers on by default', async () => {
  writeFile('numbered.txt', 'a\nb\n');
  const result = await readFileExecute({ path: 'numbered.txt' });
  assert.ok(result.includes('     1  a'));
  assert.ok(result.includes('     2  b'));
});

test('read_file supports a negative offset (from the end)', async () => {
  writeFile('tail.txt', 'abcdefghij');
  const result = await readFileExecute({ path: 'tail.txt', offset: -4, lineNumbers: false });
  assert.match(result, /^<file relative_path="tail\.txt" from=1 to=1 lines=1>\nghij\n<\/file>$/);
});

test('wrapFileContent is a pure, testable formatter', () => {
  assert.equal(
    wrapFileContent({ relativePath: 'x.js', content: 'hi', from: 1, to: 1, lines: '1' }),
    '<file relative_path="x.js" from=1 to=1 lines=1>\nhi\n</file>'
  );
});

// ---------------------------------------------------------------------------
// write_file + edit_file: verified atomic writes
// ---------------------------------------------------------------------------

test('write_file reports verified success and rejects unsafe paths', async () => {
  const ok = JSON.parse(await writeFileExecute({ path: 'nested/out.txt', content: 'hello', intent: 'write fixture' }));
  assert.equal(ok.status, 'success');
  assert.equal(ok.verified, true);
  assert.equal(readFile('nested/out.txt'), 'hello');

  const bad = JSON.parse(await writeFileExecute({ path: '../escape.txt', content: 'nope' }));
  assert.equal(bad.status, 'error');
  assert.equal(bad.code, 'INVALID_PATH');
  assert.equal(fs.existsSync(path.join(path.dirname(root), 'escape.txt')), false);
});

test('edit_file applies a pasted diff and reports the structured success/error contract', async () => {
  writeFile('patch-tool.txt', 'a\nb\n');
  const good = [
    '--- a/patch-tool.txt',
    '+++ b/patch-tool.txt',
    '@@ -1,2 +1,2 @@',
    ' a',
    '-b',
    '+B'
  ].join('\n');

  const ok = JSON.parse(await editFileExecute({ path: 'patch-tool.txt', patchStr: good, intent: 'update fixture' }));
  assert.equal(ok.status, 'success');
  assert.equal(readFile('patch-tool.txt'), 'a\nB\n');

  // A diff that does not fit the file is refused, and the file is left alone.
  const bad = JSON.parse(await editFileExecute({
    path: 'patch-tool.txt',
    patchStr: good.replace('-b', '-Z'),
    intent: 'apply a diff that no longer fits',
  }));
  assert.equal(bad.status, 'error');
  assert.equal(bad.code, 'HUNK_MISMATCH');
  assert.equal(readFile('patch-tool.txt'), 'a\nB\n', 'the refused diff changed nothing');
});

// ---------------------------------------------------------------------------
// update_task: the task.md protocol
// ---------------------------------------------------------------------------

test('parseTaskItems/markItemDone handle the task.md checkbox syntax', () => {
  const content = ['create a TUI', 'status: not started', '', 'MVP', '- [ ] first item', '- [x] done item'].join('\n');
  const items = parseTaskItems(content);

  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.done), [false, true]);
  assert.equal(items[0].text, 'first item');

  const updated = markItemDone(content, items[0], true);
  assert.ok(updated.includes('- [x] first item'));
  assert.ok(updated.includes('- [x] done item'), 'the other entry keeps its state');
  // The tick re-renders the canonical document (utils/tracking-format.js).
  assert.ok(updated.startsWith('# Task list\n'), 'the result is a canonical checklist');
});

test('renderPlan produces a resetable implementation_plan.md body', () => {
  const plan = renderPlan({ item: { text: 'conversation section' }, status: 'in progress', steps: ['wire renderer', 'verify'] });
  assert.ok(plan.startsWith('# conversation section'));
  assert.ok(plan.includes('status: in progress'));
  assert.ok(plan.includes('- [ ] wire renderer'));
});

test('update_task marks an item done, advances, and resets the plan', async () => {
  const taskContent = ['create a terminal UI', 'status: not started', '', 'MVP', '- [ ] item one', '- [ ] item two', '- [ ] item three'].join('\n');
  writeFile('task.md', taskContent);
  writeFile('implementation_plan.md', 'stale plan\n');

  const listed = JSON.parse(await updateTaskExecute({ action: 'list', intent: 'see progress' }));
  assert.equal(listed.progress.total, 3);
  assert.equal(listed.next, 'item one');

  const result = JSON.parse(await updateTaskExecute({
    action: 'complete',
    item: 'item one',
    steps: ['do the thing', 'run tests'],
    intent: 'mark item one done'
  }));

  assert.equal(result.status, 'success');
  assert.equal(result.completed, 'item one');
  assert.equal(result.next, 'item two');
  assert.equal(result.progress.done, 1);
  assert.equal(result.progress.pending, 2);

  assert.ok(readFile('task.md').includes('- [x] item one'));
  assert.ok(readFile('task.md').includes('status: in progress: item two'));

  const plan = readFile('implementation_plan.md');
  assert.ok(plan.startsWith('# item two'), 'the plan is reset for the next item');
  assert.ok(plan.includes('- [ ] do the thing'));
  assert.ok(!plan.includes('stale plan'));
});

test('update_task refuses ambiguous or unknown items without touching the files', async () => {
  writeFile('task.md', ['- [ ] alpha', '- [ ] alpha beta'].join('\n'));
  const before = readFile('task.md');

  const ambiguous = JSON.parse(await updateTaskExecute({ action: 'complete', item: 'alpha', intent: 'x' }));
  assert.equal(ambiguous.code, 'ITEM_NOT_FOUND');

  const unknown = JSON.parse(await updateTaskExecute({ action: 'complete', item: 'zzz', intent: 'x' }));
  assert.equal(unknown.code, 'ITEM_NOT_FOUND');

  assert.equal(readFile('task.md'), before);

  const byIndex = JSON.parse(await updateTaskExecute({ action: 'start', index: 2, steps: ['plan'], intent: 'start second' }));
  assert.equal(byIndex.status, 'success');
  assert.ok(readFile('implementation_plan.md').startsWith('# alpha beta'));
});

test('update_task reports a done task when nothing is pending', async () => {
  writeFile('task.md', ['- [ ] sole item'].join('\n'));
  const result = JSON.parse(await updateTaskExecute({ action: 'complete', item: 'sole item', intent: 'finish the list' }));
  assert.equal(result.next, null);
  assert.equal(result.taskStatus, 'done');
});
