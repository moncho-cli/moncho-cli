import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  READ_ONLY_TOOLS, TRACKING_TOOLS, DESIGN_WRITER_TOOLS, SCOPED_WRITER_TOOLS, SHELL_TOOLS,
  WRITER_TOOLS, DESTRUCTIVE_TOOLS, DESIGN_WRITABLE_FILES, refusalForMode, toolsForMode,
  gateForMode,
} from '../app/mode-policy.js';
import { createSessionMode, MODES, MODE_ORDER } from '../app/session-mode.js';
import { TOOL_GUARD_REFUSAL } from '../app/tool-guard.js';
import { ConversationManager } from '../app/conversation-manager.js';

/** The shipped system prompt: sent on every call, in every mode. */
const prompt = fs.readFileSync(new URL('../config/prompt.md', import.meta.url), 'utf-8');

/** A tool definition shaped like the ones `utils/tool-loader.js` produces. */
const tool = (name) => ({ type: 'function', function: { name, parameters: {} } });

const ALL = [
  tool('read_file'), tool('hint_file'), tool('blob'), tool('grep'), tool('read_capture'),
  tool('read_chunkpaction'),
  tool('web_fetch'),
  tool('compact_context'),
  tool('update_task'), tool('write_plan_md'), tool('edit_plan_md'),
  tool('write_file'), tool('edit_file'), tool('delete_file'),
  tool('run_bash'), tool('run_npm'),
];

const names = (tools) => tools.map((t) => t.function.name);

/** A normalized call as `app/tool-batch.js` builds it. */
const call = (name, args = {}) => ({ id: `c-${name}`, name, args, intent: 'probe' });

test('the tool families are disjoint, so one table decides every mode', () => {
  const families = [READ_ONLY_TOOLS, TRACKING_TOOLS, DESIGN_WRITER_TOOLS, SCOPED_WRITER_TOOLS, SHELL_TOOLS];
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
  assert.deepEqual(WRITER_TOOLS, [
    ...SCOPED_WRITER_TOOLS, ...DESIGN_WRITER_TOOLS, ...SHELL_TOOLS, ...DESTRUCTIVE_TOOLS,
  ]);
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

test('the design writers take no path, which is what makes them the mode scope', () => {
  // The scope is the tool's, not a rule the policy enforces: a writer that cannot name a
  // file cannot name the wrong one, so the generic pair is a different family.
  assert.deepEqual(DESIGN_WRITER_TOOLS, ['write_plan_md', 'edit_plan_md']);
  for (const name of DESIGN_WRITER_TOOLS) {
    assert.ok(WRITER_TOOLS.includes(name), `${name} is a writer`);
    assert.ok(!SCOPED_WRITER_TOOLS.includes(name), `${name} names no target`);
    assert.ok(!READ_ONLY_TOOLS.includes(name), `${name} is not read-only`);
  }
  // The generic writers touch any file, so they are the work-only family.
  assert.deepEqual(SCOPED_WRITER_TOOLS, ['write_file', 'edit_file']);
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

test('Design writes its own two documents through its own writers, and nothing else', () => {
  for (const name of [...READ_ONLY_TOOLS, ...TRACKING_TOOLS, ...DESIGN_WRITER_TOOLS]) {
    assert.equal(refusalForMode(MODES.DESIGN, call(name)), null, name);
  }

  // The generic writers are refused in Design whatever path they name: the mode has its
  // own tools for the two documents, so a path check is no longer the rule.
  for (const name of SCOPED_WRITER_TOOLS) {
    for (const path of [
      'app/tui.js',
      'task.md',
      'agent/sessions/s1/task.md',
      'agent/sessions/s1/implementation_plan.md',
    ]) {
      const refusal = refusalForMode(MODES.DESIGN, call(name, { path }));
      assert.equal(refusal.code, TOOL_GUARD_REFUSAL, `${name} ${path}`);
      assert.equal(refusal.mode, 'design');
      assert.match(refusal.reason, /write_plan_md \/ edit_plan_md/);
    }
    // A writer with no path at all is refused for the same reason.
    assert.match(refusalForMode(MODES.DESIGN, call(name)).reason, /unnamed target/);
  }

  // The refusal names the source it was aimed at, so the model can correct itself.
  const source = refusalForMode(MODES.DESIGN, call('write_file', { path: 'app/tui.js' }));
  assert.match(source.reason, /task\.md and implementation_plan\.md/);
  assert.match(source.reason, /app\/tui\.js/);

  // A shell cannot be scoped to two paths, so it is refused in Design as well.
  for (const name of SHELL_TOOLS) {
    const shell = refusalForMode(MODES.DESIGN, call(name));
    assert.equal(shell.mode, 'design', name);
    assert.match(shell.reason, /shell cannot be scoped/);
  }
  // And a delete is refused: a design session authors documents, it does not destroy them.
  const deletion = refusalForMode(MODES.DESIGN, call('delete_file', { path: 'task.md' }));
  assert.equal(deletion.mode, 'design');
  assert.match(deletion.reason, /removes nothing/);
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
  // Design is offered its own path-free writers instead of the generic pair, so the mode
  // is never invited to name a target it would be refused for. A shell is offered in
  // neither mode, so it is not even advertised where it is refused.
  assert.deepEqual(names(toolsForMode(MODES.DESIGN, ALL)), [
    ...READ_ONLY_TOOLS, ...TRACKING_TOOLS, ...DESIGN_WRITER_TOOLS,
  ]);
  // The tools the mode may not use are *absent* from the list, not merely refused: the
  // whole point is that they cost no tokens where they cannot be called.
  for (const name of [...SCOPED_WRITER_TOOLS, ...SHELL_TOOLS, ...DESTRUCTIVE_TOOLS]) {
    assert.ok(!names(toolsForMode(MODES.DESIGN, ALL)).includes(name), `${name} is not advertised in Design`);
    assert.ok(!names(toolsForMode(MODES.CHAT, ALL)).includes(name), `${name} is not advertised in Chat`);
  }
  // Junk is Chat, and a missing list is not a crash.
  assert.deepEqual(names(toolsForMode('nonsense', ALL)), [...READ_ONLY_TOOLS]);
  assert.deepEqual(toolsForMode(MODES.WORK, null), []);
});

test('gateForMode reads the live mode, so a Tab mid-turn bites the next call', () => {
  const mode = createSessionMode({ mode: MODES.CHAT });
  const gate = gateForMode({ getMode: () => ({ mode: mode.mode, work: mode.work }) });

  assert.equal(gate(call('write_file', { path: 'app/tui.js' })).mode, 'chat');
  assert.equal(gate(call('write_plan_md', { file: 'plan' })).mode, 'chat');

  mode.setMode(MODES.DESIGN);
  // In Design the generic writer is refused even for the session's own file...
  assert.equal(gate(call('write_file', { path: 'agent/sessions/s1/task.md' })).mode, 'design');
  // ...while the mode's own writer is allowed, because it names no path at all.
  assert.equal(gate(call('write_plan_md', { file: 'task' })), null);
  assert.equal(gate(call('edit_plan_md', { file: 'plan' })), null);

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

test('a Design turn is offered its own writers, and a generic write is still refused', async () => {
  const mode = createSessionMode({ mode: MODES.DESIGN });
  const invoked = [];
  const toolFunctions = {
    write_plan_md: async () => { invoked.push('write_plan_md'); return JSON.stringify({ status: 'success' }); },
    write_file: async () => { invoked.push('write_file'); return 'written'; },
  };
  const tools = [
    { type: 'function', function: { name: 'read_file', parameters: {} } },
    { type: 'function', function: { name: 'write_plan_md', parameters: {} } },
    { type: 'function', function: { name: 'write_file', parameters: {} } },
  ];

  const advertised = [];
  const callModel = async (messages, advertisedTools) => {
    advertised.push(advertisedTools.map((t) => t.function.name));
    if (advertised.length > 1) return { message: { role: 'assistant', content: 'Noted.' } };
    // A model naming the generic writer anyway — an older prompt, or a stale habit.
    return {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ path: 'agent/sessions/s1/task.md', intent: 'author it' }) },
        }],
      },
    };
  };

  const manager = new ConversationManager(toolFunctions, () => toolsForMode(mode.mode, tools), () => null, {
    log: () => {},
    callModel,
    toolGate: gateForMode({ getMode: () => ({ mode: mode.mode, work: mode.work }) }),
  });

  await manager.processInput('let us write the backlog for this');

  assert.deepEqual(advertised[0], ['read_file', 'write_plan_md'], 'Design is offered its own writer, not the generic one');
  assert.deepEqual(invoked, [], 'the generic write never reached its tool');
  const toolChunk = manager.chunks.find((chunk) => chunk.role === 'tool');
  assert.match(toolChunk.content, /"mode": "design"/);
  assert.match(toolChunk.content, /write_plan_md \/ edit_plan_md/);
});

test('the always-sent prompt never explains the mode, which is implicit in the tool list', () => {
  // `config/prompt.md` travels with *every* call, in every mode, so a sentence about
  // "in a design session…" is an instruction about a state the model cannot observe: it
  // would be wrong in two of the three modes and the model would have to ignore it. The
  // mode is implicit in the list `toolsForMode()` hands over, and anything conditional
  // belongs in the refusal the model receives or in the description of the tool it is
  // offered — never in prose it reads when the condition does not hold.
  // The prompt legitimately uses some of these words for other things ("a design smell"
  // in the file-size rule), so the guard is on the *phrasings* that talk about the mode:
  // naming a session's mode, a mode by name as a state, or the gate's own code.
  for (const phrasing of [
    /\bdesign (?:mode|session)\b/i,
    /\bchat (?:mode|session)\b/i,
    /\bsession'?s? mode\b/i,
    /\bthe mode\b/i,
    /work:on/i,
    /work lock/i,
    /TOOL_REFUSED_BY_MODE/,
  ]) {
    assert.doesNotMatch(prompt, phrasing, `the prompt must not explain ${phrasing}`);
  }

  // The three modes are still the ones the policy knows — the rule is about the prompt,
  // not about forgetting the modes exist.
  assert.deepEqual([...MODE_ORDER], ['chat', 'design', 'work']);
});

test('the tracking writers are described by what they do, not by when they are offered', () => {
  // The same rule, at the one place it is easiest to get wrong: the two design-mode
  // writers are named in the prompt, so they must be described by their behaviour —
  // they author the session's pair and take no path — and never as "the design session's
  // tools", which is a condition the model cannot check.
  const section = prompt.slice(prompt.indexOf('**write_plan_md**'), prompt.indexOf('A write or a patch'));
  assert.ok(section.length > 0, 'the prompt still names the two tracking writers');
  assert.match(section, /no `path` argument at all/i, 'it says what makes them different');
  assert.match(section, /`"task"` or `"plan"`/, 'and how the call names the document');
  assert.doesNotMatch(section, /\bdesign\b/i, 'but never as the tools of a mode');
  assert.doesNotMatch(section, /\bchat\b/i);
});
