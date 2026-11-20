import test from 'node:test';
import assert from 'node:assert/strict';

import {
  READ_ONLY_TOOLS, TRACKING_TOOLS, SCOPED_WRITER_TOOLS, SHELL_TOOLS, WRITER_TOOLS,
  DESTRUCTIVE_TOOLS, DESIGN_WRITABLE_FILES, normalizeTargetPath, isDesignWritable,
  refusalForMode, toolsForMode, gateForMode,
} from '../app/mode-policy.js';
import { createSessionMode, MODES } from '../app/session-mode.js';
import { TOOL_GUARD_REFUSAL } from '../app/tool-guard.js';
import { ConversationManager } from '../app/conversation-manager.js';

/** A tool definition shaped like the ones `utils/tool-loader.js` produces. */
const tool = (name) => ({ type: 'function', function: { name, parameters: {} } });

const ALL = [
  tool('read_file'), tool('hint_file'), tool('blob'), tool('grep'), tool('read_capture'),
  tool('compact_context'),
  tool('update_task'), tool('write_file'), tool('edit_file'), tool('delete_file'),
  tool('run_bash'), tool('run_npm'),
];

const names = (tools) => tools.map((t) => t.function.name);

/** A normalized call as `app/tool-batch.js` builds it. */
const call = (name, args = {}) => ({ id: `c-${name}`, name, args, intent: 'probe' });

test('the tool families are disjoint, so one table decides every mode', () => {
  const families = [READ_ONLY_TOOLS, TRACKING_TOOLS, SCOPED_WRITER_TOOLS, SHELL_TOOLS];
  for (const family of families) {
    assert.equal(new Set(family).size, family.length, 'a family holds no duplicate');
  }
  const seen = new Set();
  for (const family of families) {
    for (const name of family) {
      assert.ok(!seen.has(name), `${name} belongs to exactly one family`);
      seen.add(name);
    }
  }
  assert.deepEqual(WRITER_TOOLS, [...SCOPED_WRITER_TOOLS, ...SHELL_TOOLS, ...DESTRUCTIVE_TOOLS]);
  // A shell can write a file, so it is a writer and never "read-only".
  for (const name of SHELL_TOOLS) {
    assert.ok(!READ_ONLY_TOOLS.includes(name));
    assert.ok(!SCOPED_WRITER_TOOLS.includes(name));
  }
  // A delete removes a file, so it is a writer too — and never a scoped one: no file a
  // mode may write is one it may destroy, so the family takes no path check at all.
  for (const name of DESTRUCTIVE_TOOLS) {
    assert.ok(WRITER_TOOLS.includes(name), `${name} is a writer`);
    assert.ok(!SCOPED_WRITER_TOOLS.includes(name), `${name} is not a scoped writer`);
    assert.ok(!READ_ONLY_TOOLS.includes(name), `${name} is not read-only`);
  }
  assert.deepEqual(DESIGN_WRITABLE_FILES, ['task.md', 'implementation_plan.md']);
});

test('normalizeTargetPath collapses the ways one file can be spelled', () => {
  for (const spelling of ['task.md', './task.md', 'a/../task.md', 'a/b/../../task.md']) {
    assert.equal(normalizeTargetPath(spelling), 'task.md', spelling);
  }
  assert.equal(normalizeTargetPath('/task.md'), 'task.md');
  assert.equal(normalizeTargetPath('sub\\task.md'), 'sub/task.md');
  assert.equal(normalizeTargetPath('  task.md  '), 'task.md');
  // Anything that walks out of the project is never a writable target.
  assert.equal(normalizeTargetPath('../task.md'), '');
  assert.equal(normalizeTargetPath('a/../../task.md'), '');
  assert.equal(normalizeTargetPath(''), '');
  assert.equal(isDesignWritable('./implementation_plan.md'), true);
  assert.equal(isDesignWritable('src/task.md'), false);
});

test('Chat is read-only: every writer is refused and every reader is allowed', () => {
  for (const name of READ_ONLY_TOOLS) {
    assert.equal(refusalForMode(MODES.CHAT, call(name)), null, name);
  }
  for (const name of WRITER_TOOLS) {
    const refusal = refusalForMode(MODES.CHAT, call(name, { path: 'task.md' }));
    assert.equal(refusal.code, TOOL_GUARD_REFUSAL, name);
    assert.equal(refusal.mode, 'chat');
    assert.equal(refusal.tool, name);
    assert.match(refusal.reason, /read-only/);
  }
  // `update_task` writes the tracking files, and Chat runs no writing tool at all.
  assert.equal(refusalForMode(MODES.CHAT, call('update_task')).mode, 'chat');
});

test('Design writes the two tracking files and nothing else', () => {
  for (const name of [...READ_ONLY_TOOLS, ...TRACKING_TOOLS]) {
    assert.equal(refusalForMode(MODES.DESIGN, call(name)), null, name);
  }
  assert.equal(refusalForMode(MODES.DESIGN, call('write_file', { path: 'task.md' })), null);
  assert.equal(refusalForMode(MODES.DESIGN, call('edit_file', { path: './task.md' })), null);
  assert.equal(refusalForMode(MODES.DESIGN, call('write_file', { path: 'implementation_plan.md' })), null);

  // A session writes its own pair where they now live, under agent/sessions/<id>/.
  for (const path of [
    'agent/sessions/2026-02-14T10-30-00-000Z/task.md',
    './agent/sessions/s1/implementation_plan.md',
  ]) {
    assert.equal(refusalForMode(MODES.DESIGN, call('write_file', { path })), null, path);
  }
  // But only there: one folder deep, and only the two names.
  for (const path of [
    'agent/sessions/task.md',
    'agent/sessions/a/b/task.md',
    'agent/sessions/s1/notes.md',
    'agent/sessions/s1/../task.md',
  ]) {
    assert.ok(refusalForMode(MODES.DESIGN, call('write_file', { path })), path);
  }

  const source = refusalForMode(MODES.DESIGN, call('write_file', { path: 'app/tui.js' }));
  assert.equal(source.code, TOOL_GUARD_REFUSAL);
  assert.equal(source.mode, 'design');
  assert.match(source.reason, /task\.md and implementation_plan\.md/);
  assert.match(source.reason, /app\/tui\.js/);

  // A shell cannot be scoped to two paths, so it is refused in Design as well.
  for (const name of SHELL_TOOLS) {
    const shell = refusalForMode(MODES.DESIGN, call(name));
    assert.equal(shell.mode, 'design', name);
    assert.match(shell.reason, /shell cannot be scoped/);
  }
  // A scoped writer with no path is refused too, and the reason says so.
  assert.match(refusalForMode(MODES.DESIGN, call('write_file')).reason, /unnamed target/);
});

test('Work is unrestricted, and an unknown mode falls back to the read-only rule', () => {
  for (const name of [...READ_ONLY_TOOLS, ...TRACKING_TOOLS, ...WRITER_TOOLS]) {
    assert.equal(refusalForMode(MODES.WORK, call(name, { path: 'app/tui.js' })), null, name);
  }
  // `normalizeMode()` is the single fallback rule: junk is `chat`, never `work`.
  assert.equal(refusalForMode('nonsense', call('write_file', { path: 'app/tui.js' })).mode, 'chat');
  assert.equal(refusalForMode(undefined, call('run_bash')).mode, 'chat');
});

test('toolsForMode narrows the list the provider is offered', () => {
  const work = toolsForMode(MODES.WORK, ALL);
  assert.deepEqual(names(work), names(ALL));
  // The list is copied, never the caller's array.
  assert.notEqual(work, ALL);

  assert.deepEqual(names(toolsForMode(MODES.CHAT, ALL)), [...READ_ONLY_TOOLS]);
  // Design keeps the scoped writers: the gate is what keeps them on the tracking
  // files, and hiding `write_file` from the mode that writes `task.md` would be wrong.
  // A shell is offered in neither, so it is not even advertised where it is refused.
  assert.deepEqual(names(toolsForMode(MODES.DESIGN, ALL)), [
    ...READ_ONLY_TOOLS, ...TRACKING_TOOLS, ...SCOPED_WRITER_TOOLS,
  ]);
  // Junk is Chat, and a missing list is not a crash.
  assert.deepEqual(names(toolsForMode('nonsense', ALL)), [...READ_ONLY_TOOLS]);
  assert.deepEqual(toolsForMode(MODES.WORK, null), []);
});

test('gateForMode reads the live mode, so a Tab mid-turn bites the next call', () => {
  const mode = createSessionMode({ mode: MODES.CHAT });
  const gate = gateForMode({ getMode: () => ({ mode: mode.mode, work: mode.work }) });

  assert.equal(gate(call('write_file', { path: 'app/tui.js' })).mode, 'chat');

  mode.setMode(MODES.DESIGN);
  assert.equal(gate(call('write_file', { path: 'app/tui.js' })).mode, 'design');
  assert.equal(gate(call('write_file', { path: 'task.md' })), null);

  mode.setWork(true);
  assert.equal(gate(call('write_file', { path: 'app/tui.js' })), null);
});

test('gateForMode accepts a fixed mode and a fixed lock', () => {
  assert.equal(gateForMode({ mode: MODES.CHAT })(call('read_file')), null);
  assert.equal(gateForMode({ mode: MODES.CHAT })(call('run_npm')).code, TOOL_GUARD_REFUSAL);
  // A locked session is a `work` session even if the mode field is stale.
  assert.equal(gateForMode({ mode: MODES.CHAT, work: true })(call('run_npm')), null);
});

test('a Chat turn advertises the read-only list and refuses the write the model still names', async () => {
  const mode = createSessionMode({ mode: MODES.CHAT });
  const invoked = [];
  const toolFunctions = {
    read_file: async () => { invoked.push('read_file'); return 'fixture content'; },
    write_file: async () => { invoked.push('write_file'); return 'written'; },
  };
  const tools = [
    { type: 'function', function: { name: 'read_file', parameters: {} } },
    { type: 'function', function: { name: 'write_file', parameters: {} } },
  ];

  // What the turn runner sends to the provider, captured per call.
  const advertised = [];
  const callModel = async (messages, advertisedTools) => {
    advertised.push(advertisedTools.map((t) => t.function.name));
    // The turn ends on the second call: the first one names the write, and the reply
    // that follows the refusal is tool-free.
    if (advertised.length > 1) return { message: { role: 'assistant', content: 'Understood.' } };
    // The model names a write anyway — the list is an invitation, not a guarantee.
    return {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ path: 'app/tui.js', intent: 'rewrite it' }) },
        }],
      },
    };
  };

  const manager = new ConversationManager(toolFunctions, () => toolsForMode(mode.mode, tools), () => null, {
    log: () => {},
    callModel,
    toolGate: gateForMode({ getMode: () => ({ mode: mode.mode, work: mode.work }) }),
  });

  await manager.processInput('how would we refactor app/tui.js?');

  // The list is filtered, not rewritten: the reader stays, the writer is dropped.
  assert.deepEqual(advertised[0], ['read_file'], 'Chat is only offered the tools it may use');
  assert.deepEqual(invoked, [], 'the refused write never reached its tool');
  const toolChunk = manager.chunks.find((chunk) => chunk.role === 'tool');
  assert.ok(toolChunk, 'the refused call still owes the provider one result');
  assert.match(toolChunk.content, new RegExp(TOOL_GUARD_REFUSAL));
  assert.match(toolChunk.content, /"mode": "chat"/);
  assert.match(toolChunk.content, /"tool": "write_file"/, 'the refusal names the tool');
  assert.match(toolChunk.content, /"guidance":/, 'the model is told how to recover');
  assert.match(toolChunk.content, /strictly read-only/);
});
