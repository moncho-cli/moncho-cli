import test from 'node:test';
import assert from 'node:assert/strict';

import {
  allowAllGate,
  guardToolCall,
  formatGuardRefusal,
  TOOL_GUARD_REFUSAL,
} from '../app/tool-guard.js';
import { dispatchToolCalls, handleToolBatch } from '../app/tool-batch.js';
import { formatRefusalLine, isRefusalLine } from '../app/refusal-line.js';
import { classifyLine, colorizeLine } from '../app/theme.js';

/**
 * The pre-dispatch call gate: the one seam that can refuse a call before it runs.
 *
 * The batch is asked to refuse *some* calls and run others, so both halves of the
 * contract are proven here: a gate that answers with a refusal turns the call into
 * a structured `[error]` outcome (no tool invoked), and no gate at all leaves the
 * batch exactly as it was.
 */

const call = (name, id = 'call_1') => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify({ intent: 'probe' }) },
});

test('guardToolCall() allows every call when no gate is installed', () => {
  assert.equal(guardToolCall({ name: 'write_file' }, null), null);
  assert.equal(guardToolCall({ name: 'write_file' }, allowAllGate), null);
  assert.equal(guardToolCall({ name: 'write_file' }, () => null), null);
  assert.equal(guardToolCall({ name: 'write_file' }, () => undefined), null);
  assert.equal(guardToolCall({ name: 'write_file' }, () => false), null);
});

test('guardToolCall() turns a gate answer into a structured refusal', () => {
  const refusal = guardToolCall({ name: 'write_file' }, () => ({ reason: 'Chat is read-only', mode: 'chat' }));

  assert.equal(refusal.reason, 'Chat is read-only');
  assert.equal(refusal.code, TOOL_GUARD_REFUSAL);
  assert.equal(refusal.mode, 'chat');

  // `true` is an explicit allow; a refusal without a reason still gets one.
  assert.equal(guardToolCall({ name: 'write_file' }, () => true), null);
  const bare = guardToolCall({ name: 'write_file' }, () => ({}));
  assert.equal(bare.reason, 'the current mode does not allow this call');
  assert.equal(bare.mode, null);
});

test('a gate that throws fails closed instead of running the tool', () => {
  const refusal = guardToolCall({ name: 'write_file' }, () => { throw new Error('policy down'); });

  assert.match(refusal.reason, /policy down/);
  assert.equal(refusal.code, TOOL_GUARD_REFUSAL);
  assert.match(refusal.guidance, /could not be evaluated/);
});

test('formatGuardRefusal() names the tool, the mode and the reason', () => {
  const body = JSON.parse(formatGuardRefusal({
    name: 'write_file',
    reason: 'Design can only write the tracking files',
    mode: 'design',
    guidance: 'Ask to switch to Work.',
  }));

  assert.equal(body.status, 'error');
  assert.equal(body.code, TOOL_GUARD_REFUSAL);
  assert.equal(body.tool, 'write_file');
  assert.equal(body.mode, 'design');
  assert.match(body.message, /Design can only write the tracking files/);
  assert.equal(body.guidance, 'Ask to switch to Work.');
});

test('dispatchToolCalls() refuses a gated call without invoking the tool', async () => {
  const invoked = [];
  const toolFunctions = {
    write_file: async () => { invoked.push('write_file'); return 'written'; },
    read_file: async () => { invoked.push('read_file'); return 'contents'; },
  };
  const gate = (toolCall) => (toolCall.name === 'write_file' ? { reason: 'Chat is read-only', mode: 'chat' } : null);

  const outcomes = await dispatchToolCalls(
    [{ index: 0, call: { id: 'call_1', name: 'read_file', args: { intent: 'x' }, rawArgs: {}, intent: 'x' } },
      { index: 1, call: { id: 'call_2', name: 'write_file', args: { intent: 'y' }, rawArgs: {}, intent: 'y' } }],
    toolFunctions,
    { gate },
  );

  assert.deepEqual(invoked, ['read_file'], 'the refused call must never reach its tool');
  assert.equal(outcomes[0].succeeded, true);
  assert.equal(outcomes[1].isError, true);
  assert.equal(outcomes[1].refused, true);
  assert.equal(outcomes[1].succeeded, false);
  assert.equal(JSON.parse(outcomes[1].result).code, TOOL_GUARD_REFUSAL);
});

test('without a gate the batch runs every accepted call, as before', async () => {
  let ran = 0;
  const window = { chunks: [], add(chunk) { this.chunks.push(chunk); } };

  const report = await handleToolBatch({
    toolCalls: [call('read_file')],
    window,
    toolFunctions: { read_file: async () => { ran += 1; return 'contents'; } },
  });

  assert.equal(ran, 1);
  assert.equal(report.guarded, 0);
  assert.equal(report.executed, 1);
  assert.equal(window.chunks.at(-1).role, 'tool');
});

test('handleToolBatch() stores a refusal as the tool chunk of the refused call', async () => {
  const window = { chunks: [], add(chunk) { this.chunks.push(chunk); } };
  const lines = [];

  const report = await handleToolBatch({
    toolCalls: [call('write_file')],
    window,
    log: (line) => lines.push(line),
    toolFunctions: { write_file: async () => 'should not run' },
    gate: () => ({ reason: 'Work is off', mode: 'chat' }),
  });

  const toolChunk = window.chunks.find((chunk) => chunk.role === 'tool');
  assert.ok(toolChunk, 'a refused call still gets the one result per call it owes the provider');
  assert.match(toolChunk.content, /Work is off/, 'the refusal reaches the model');
  assert.equal(report.guarded, 1);
  assert.equal(report.executed, 1);
  assert.deepEqual(report.order, [toolChunk.tool_call_id]);
});

test('a refused call prints a bright row that names it, and still tells the model why', async () => {
  const window = { chunks: [], add(chunk) { this.chunks.push(chunk); } };
  const lines = [];
  const reason = 'Design writes only the tracking files';

  const report = await handleToolBatch({
    toolCalls: [call('write_file')],
    window,
    log: (line) => lines.push(String(line)),
    toolFunctions: { write_file: async () => 'should not run' },
    gate: () => ({ reason, mode: 'design' }),
  });

  // The reader gets one row, where the refused call was announced, saying which
  // call, in which mode, and why.
  const row = lines.find((line) => isRefusalLine(line));
  assert.ok(row, `the refusal is shown next to the call: ${JSON.stringify(lines)}`);
  assert.equal(row, formatRefusalLine({ name: 'write_file', reason, mode: 'design' }));
  assert.match(row, /write_file/);
  assert.match(row, /design/);
  assert.match(row, new RegExp(reason));

  // It is the palette's own refusal kind: bright red and bold, never the plain red
  // an error row carries (the two sit side by side in a real transcript).
  assert.equal(classifyLine(row), 'refusal');
  assert.match(colorizeLine(row), /^\{bright-red-fg\}\{bold\}/);

  // The model gets the same reason in its own chunk, so both halves agree.
  const toolChunk = window.chunks.find((chunk) => chunk.role === 'tool');
  assert.match(toolChunk.content, new RegExp(reason));
  assert.equal(report.guarded, 1);
});