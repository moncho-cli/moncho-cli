import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadTools } from '../utils/tool-loader.js';
import { hasIntentParameter, parseToolArgs, getIntent, withIntentParameter } from '../utils/tool-schema.js';
import { execute as readFileExecute, wrapFileContent } from '../tools/read_file.js';
import { execute as writeFileExecute } from '../tools/write_file.js';
import { execute as runBashExecute, validateCommand, tokenizeCommand } from '../tools/run_bash.js';
import { validateNpmArgs, splitNpmArgs } from '../tools/run_npm.js';
import { execute as compactExecute, planCompaction } from '../tools/compact_context.js';
import { execute as updateTaskExecute, parseTaskItems, markItemDone, renderPlan } from '../tools/update_task.js';
import { execute as patchFileExecute } from '../tools/patch_file.js';
import { ContextWindow } from '../app/context-window.js';
import { detectCompactionRequest } from '../app/conversation-manager.js';
import { registerContextWindow, clearContextWindow } from '../utils/host.js';
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateRequestTokens,
  exceedsTokenBudget,
  formatTokenCount,
  formatUsage
} from '../utils/tokens.js';
import { splitByTokenBudget, compactChunks, buildSummaryChunk } from '../utils/compaction.js';
import { COMPACTION_SUMMARY_PREFIX } from '../config/constants.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-harness-test-'));
process.chdir(root);

function writeFile(name, content) {
  fs.mkdirSync(path.dirname(name), { recursive: true });
  fs.writeFileSync(name, content, 'utf-8');
}

function readFile(name) {
  return fs.readFileSync(name, 'utf-8');
}

function chunk(text, role = 'user') {
  return { role, content: text };
}

// ---------------------------------------------------------------------------
// Task.md item 6: the shared "intent" tool-call contract
// ---------------------------------------------------------------------------

test('every auto-loaded tool declares the required intent parameter', async () => {
  const { tools, toolFunctions } = await loadTools(() => {});
  assert.ok(tools.length >= 7, `expected the harness toolset, got ${tools.length}`);

  for (const tool of tools) {
    assert.ok(hasIntentParameter(tool), `${tool.function.name} is missing "intent"`);
    assert.equal(typeof toolFunctions[tool.function.name], 'function');
  }

  const names = tools.map((t) => t.function.name);
  for (const expected of ['read_file', 'write_file', 'patch_file', 'run_bash', 'run_npm', 'compact_context', 'update_task']) {
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
// write_file + patch_file: verified atomic writes
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

test('patch_file still reports the structured success/error contract', async () => {
  writeFile('patch-tool.txt', 'a\nb\n');
  const good = [
    '--- a/patch-tool.txt',
    '+++ b/patch-tool.txt',
    '@@ -1,2 +1,2 @@',
    ' a',
    '-b',
    '+B'
  ].join('\n');

  const ok = JSON.parse(await patchFileExecute({ path: 'patch-tool.txt', patchStr: good, intent: 'update fixture' }));
  assert.equal(ok.status, 'success');
  assert.equal(readFile('patch-tool.txt'), 'a\nB\n');

  const bad = JSON.parse(await patchFileExecute({ path: 'patch-tool.txt', patchStr: good.replace(' a', ' a') }));
  assert.equal(bad.status, 'error');
});

// ---------------------------------------------------------------------------
// run_bash hardening
// ---------------------------------------------------------------------------

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
  assert.equal(ok.trim(), 'ls-target.txt');

  const blocked = JSON.parse(await runBashExecute({ command: 'ls && whoami' }));
  assert.equal(blocked.code, 'SHELL_METACHARACTER');

  const missing = JSON.parse(await runBashExecute({ command: 'cat does-not-exist.txt' }));
  assert.equal(missing.status, 'error');
  assert.equal(missing.code, 'COMMAND_FAILED');

  assert.ok((await runBashExecute({ command: 'pwd' })).includes(root));
});

// ---------------------------------------------------------------------------
// run_npm
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tokens (task.md item 3)
// ---------------------------------------------------------------------------

test('token estimates are additive, rounded up and never negative', () => {
  assert.equal(estimateMessageTokens('abcd'), 1);
  assert.equal(estimateMessageTokens('abcde'), 2);
  assert.equal(estimateMessagesTokens(['abcd', 'abcd']), 2);
  assert.equal(estimateMessageTokens(null), 0);
  assert.ok(estimateMessageTokens({ role: 'user', content: 'x'.repeat(100) }) > 100 / 4);
  assert.ok(estimateRequestTokens([{ role: 'user', content: 'hi' }], [{ type: 'function' }]) > 0);
});

test('budget helpers and formatting', () => {
  const messages = [{ role: 'user', content: 'x'.repeat(400) }];
  assert.equal(exceedsTokenBudget(messages, 1000), false);
  assert.equal(exceedsTokenBudget(messages, 10), true);
  assert.equal(exceedsTokenBudget(messages, 0), false); // 0 = no limit
  assert.equal(formatTokenCount(1500), '1.50k');
  assert.match(formatUsage(messages, 1000), /tokens \(\d+%\)$/);
  assert.match(formatUsage(messages, 0), /\(no limit\)$/);
});

// ---------------------------------------------------------------------------
// Compaction (task.md item 8)
// ---------------------------------------------------------------------------

test('the older 80% / newest 20% split is driven by token mass', () => {
  const chunks = Array.from({ length: 5 }, (_, i) => chunk('x'.repeat(400), `m${i}`));
  const split = splitByTokenBudget(chunks);

  assert.equal(split.totalTokens, split.olderTokens + split.keptTokens);
  assert.ok(split.older.length > 0, 'something must be compacted');
  assert.ok(split.kept.length > 0, 'the newest chunks must survive');
  assert.ok(split.keptTokens >= split.totalTokens * 0.2 * 0.9, 'kept block should be ~20%');
  assert.ok(split.olderTokens >= split.keptTokens, 'the evicted block carries the bulk of the mass');
  assert.equal(split.older.at(-1), chunks[split.older.length - 1]);
  assert.equal(split.kept[0], chunks[split.older.length]);
});

test('a window of one chunk is never compacted away', () => {
  const split = splitByTokenBudget([chunk('only')]);
  assert.equal(split.older.length, 0);
  assert.equal(split.kept.length, 1);
});

test('compactChunks replaces the old block with one summary chunk and keeps the tail verbatim', async () => {
  const chunks = [
    chunk('AAAA'.repeat(100)),
    chunk('BBBB'.repeat(100)),
    chunk('recent-1'),
    chunk('recent-2')
  ];
  const { older, kept } = splitByTokenBudget(chunks);

  const result = await compactChunks(chunks, {
    callModel: async (messages) => {
      assert.equal(messages[0].role, 'system');
      assert.match(messages[1].content, /AAAA/); // the evicted text is what gets summarised
      assert.ok(!/recent-2/.test(messages[1].content), 'kept chunks must not be summarised');
      return 'SUMMARY: intent, done, pending';
    }
  });

  assert.equal(result.compacted, true);
  assert.equal(result.chunks[0].content, `${COMPACTION_SUMMARY_PREFIX}\nSUMMARY: intent, done, pending`);
  assert.equal(result.chunks[0].compacted, true);
  assert.equal(result.chunks[0].summarized_chunks, older.length);
  assert.deepEqual(result.chunks.slice(1), kept);
  assert.ok(result.stats.afterTokens < result.stats.totalTokens, 'compaction must shrink the window');
  assert.ok(result.summary.includes('SUMMARY'));
});

test('compactChunks can report the split without calling the model', async () => {
  const chunks = [chunk('x'.repeat(400)), chunk('y'.repeat(400)), chunk('tail')];
  const result = await compactChunks(chunks, { dryRun: true });
  assert.equal(result.compacted, false);
  assert.equal(result.dryRun, true);
  assert.ok(result.stats.olderChunks > 0);
});

test('compactChunks refuses to squash an empty older block', async () => {
  const result = await compactChunks([chunk('only')], { callModel: async () => 'nope' });
  assert.equal(result.compacted, false);
  assert.equal(result.reason, 'nothing_to_compact');
});

test('an empty summary is rejected so the window is left unchanged', async () => {
  const chunks = [chunk('a'.repeat(400)), chunk('b'.repeat(400)), chunk('c')];
  await assert.rejects(
    () => compactChunks(chunks, { callModel: async () => '   ' }),
    /empty summary/
  );
});

test('buildSummaryChunk marks the compacted chunk', () => {
  const built = buildSummaryChunk(' body ', { summarizedChunks: 3 });
  assert.equal(built.compacted, true);
  assert.equal(built.summarized_chunks, 3);
  assert.ok(built.content.startsWith(COMPACTION_SUMMARY_PREFIX));
  assert.ok(built.content.endsWith('body'));
});

// ---------------------------------------------------------------------------
// ContextWindow wiring
// ---------------------------------------------------------------------------

test('ContextWindow reports usage and compacts in place when over budget', async () => {
  const window = new ContextWindow({ maxTokens: 200 });
  window.addMany([
    chunk('x'.repeat(2000), 'user'),
    chunk('y'.repeat(2000), 'assistant'),
    chunk('recent-1'),
    chunk('recent-2')
  ]);

  assert.equal(window.needsCompaction(), true);
  assert.match(window.usage(), /\/ 200 tokens/);
  assert.ok(window.estimatedTokens() > 200);

  const before = window.estimatedTokens();
  const report = await window.compact({ callModel: async () => 'condensed history' });

  assert.equal(report.compacted, true);
  assert.equal(window.chunks[0].compacted, true);
  assert.equal(window.chunks.at(-1).content, 'recent-2');
  assert.ok(window.estimatedTokens() < before, 'the window must shrink');
  assert.equal(window.stats().compactions, 1);
  assert.equal(window.stats().lastCompaction.reason, 'over-budget');
});

test('ContextWindow compaction is skipped while inside the budget', async () => {
  const window = new ContextWindow({ maxTokens: 100000 });
  window.add(chunk('small'));
  const report = await window.compact({ callModel: async () => { throw new Error('must not be called'); } });
  assert.equal(report.compacted, false);
  assert.equal(report.reason, 'within-budget');
});

test('a failed summariser call leaves the window untouched', async () => {
  const window = new ContextWindow({ maxTokens: 50 });
  window.addMany([chunk('x'.repeat(4000)), chunk('y'.repeat(4000)), chunk('tail')]);
  const before = window.chunks.slice();

  await assert.rejects(() => window.compact({ callModel: async () => { throw new Error('provider down'); } }), /provider down/);
  assert.deepEqual(window.chunks, before);
});

// ---------------------------------------------------------------------------
// compact_context tool
// ---------------------------------------------------------------------------

test('compact_context reports within-budget windows and requests compaction when over', async () => {
  const window = new ContextWindow({ maxTokens: 100 });
  registerContextWindow(window);

  const within = JSON.parse(await compactExecute({ intent: 'check window' }));
  assert.equal(within.status, 'skipped');
  assert.equal(within.code, 'WITHIN_BUDGET');

  window.addMany([chunk('z'.repeat(4000)), chunk('tail')]);
  const plan = planCompaction(window);
  assert.equal(plan.required, true);

  const requested = JSON.parse(await compactExecute({ intent: 'shrink window' }));
  assert.equal(requested.status, 'requested');
  assert.equal(requested.code, 'COMPACTION_REQUESTED');
  assert.equal(requested.defer, false, 'dryRun defaults to true, so the host loop is not deferred');
  assert.equal(detectCompactionRequest(JSON.stringify(requested)), false);

  const deferred = JSON.parse(await compactExecute({ intent: 'shrink window', dryRun: false }));
  assert.equal(deferred.defer, true);
  assert.equal(detectCompactionRequest(JSON.stringify(deferred)), true);

  clearContextWindow();
  const orphan = JSON.parse(await compactExecute({ intent: 'no window' }));
  assert.equal(orphan.code, 'NO_CONTEXT_WINDOW');
});

// ---------------------------------------------------------------------------
// update_task (the task.md protocol)
// ---------------------------------------------------------------------------

test('parseTaskItems/markItemDone handle the task.md checkbox syntax', () => {
  const content = ['create a TUI', 'status: not started', '', 'MVP', '- [ ] first item', '- [x] done item'].join('\n');
  const items = parseTaskItems(content);

  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.done), [false, true]);
  assert.equal(items[0].text, 'first item');

  const updated = markItemDone(content, items[0], true);
  assert.ok(updated.includes('- [x] first item'));
  assert.equal(updated.split('\n').length, content.split('\n').length);
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
