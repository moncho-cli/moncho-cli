import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatArgType,
  formatCallSignature,
  formatMulticallHeader,
  formatMulticallEnvelope,
  parseMulticallEnvelope,
  formatToolResultChunk,
  parseToolChunk,
  MULTICALL_FOOTER,
} from '../app/tool-call-format.js';
import { replayChunks } from '../app/session-replay.js';

/**
 * The multicall grammar (task-backlog: "tool calling should allow the model to
 * ask with an array of tools, up to 5 simultaneous calls. the responses would be
 * added in the context enclosed in `<tool-multicall result><tool-call
 * name=call-signature>…`").
 *
 * These cases are pure string work: the call signature, the envelope that carries
 * a batched result, the round-trip back into a plain body, and what the replay
 * does with an enveloped chunk. The *dispatch* half of the feature — the cap, the
 * simultaneous run and the stored chunks — is proven in `tests/tool-batch.test.js`.
 */

/** One OpenAI-shaped tool call, the way a provider answers. */
const call = (id, name, args) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

test('formatCallSignature() summarises the tool name and the type of each parameter', () => {
  assert.equal(
    formatCallSignature({ name: 'read_file', args: { path: 'task.md', intent: 'read it' } }),
    'read_file(path=string(7), intent=string(7))',
    'the backlog example: name=type(length)',
  );
  assert.equal(
    formatCallSignature({ name: 'grep', args: { pattern: 'x', limit: 20, fixed: true, deep: null } }),
    'grep(pattern=string(1), limit=number, fixed=boolean, deep=null)',
  );
  assert.equal(
    formatCallSignature({ name: 'blob', args: { paths: ['a', 'b'], opts: { x: 1 } } }),
    'blob(paths=array, opts=object)',
  );
  // arguments that did not parse still describe something useful
  assert.equal(formatCallSignature({ name: 'edit_file', args: 'not json' }), 'edit_file(raw=string(8))');
  assert.equal(formatCallSignature({ name: 'pwd' }), 'pwd()');
  assert.equal(formatCallSignature(), 'unknown_tool()');
  assert.equal(formatArgType('abc'), 'string(3)');
  assert.equal(formatArgType(12), 'number');
});

test('the multicall envelope wraps a result and reads it back byte-for-byte', () => {
  const chunk = formatToolResultChunk({
    intent: 'read the fixture',
    signature: 'read_file(path=string(11))',
    result: 'line one\nline two',
    calls: 3,
  });

  assert.equal(chunk.split('\n')[0], 'intent: read the fixture', 'the intent stays the first line');
  assert.equal(chunk.split('\n')[1], formatMulticallHeader(3), 'the header carries the batch size');
  assert.equal(chunk.split('\n')[1], '<tool-multicall result calls=3>');
  assert.ok(chunk.includes('<tool-call name="read_file(path=string(11))">'));
  assert.ok(chunk.endsWith(MULTICALL_FOOTER));

  const parsed = parseToolChunk(chunk);
  assert.equal(parsed.intent, 'read the fixture');
  assert.equal(parsed.signature, 'read_file(path=string(11))');
  assert.equal(parsed.calls, 3, 'the batch size is the header count, not the element count');
  assert.equal(parsed.body, 'line one\nline two', 'the body is unwrapped exactly');

  // the envelope on its own: a declared count of one is read greedily
  const envelope = formatMulticallEnvelope({
    entries: [{ signature: 'a(x=string(1))', body: 'inner' }],
    calls: 1,
  });
  assert.deepEqual(parseMulticallEnvelope(envelope), {
    calls: 1,
    elements: 1,
    entries: [{ signature: 'a(x=string(1))', body: 'inner' }],
  });

  // several elements: each closing line ends one element
  const many = formatMulticallEnvelope({
    entries: [{ signature: 'a()', body: 'one' }, { signature: 'b()', body: 'two' }],
    calls: 5,
  });
  const readMany = parseMulticallEnvelope(many);
  assert.equal(readMany.calls, 5, 'the batch size stays what the header declared');
  assert.deepEqual(readMany.entries.map((e) => e.body), ['one', 'two']);

  // not an envelope at all: null, never a throw
  assert.equal(parseMulticallEnvelope('plain result'), null);
  assert.equal(parseMulticallEnvelope('<tool-multicall result calls=1>\n<tool-call name="x">\ny\n</tool-call>'), null);
  assert.equal(parseMulticallEnvelope(''), null);
  assert.equal(parseMulticallEnvelope(null), null);
});

test('parseToolChunk() reads an enveloped chunk and a pre-envelope chunk the same way', () => {
  const legacy = parseToolChunk('intent: read it\nfixture content');
  assert.deepEqual(legacy, {
    intent: 'read it',
    signature: '',
    calls: 1,
    isError: false,
    body: 'fixture content',
  }, 'a chunk written before the envelope keeps its historical reading');

  const enveloped = parseToolChunk(formatToolResultChunk({
    intent: 'read it',
    signature: 'read_file(path=string(7))',
    result: 'fixture content',
  }));
  assert.equal(enveloped.body, legacy.body, 'both shapes yield the same body');
  assert.equal(enveloped.intent, legacy.intent);

  // the error marker is looked for *inside* the envelope
  const failed = parseToolChunk(formatToolResultChunk({
    intent: 'run it',
    signature: 'run_bash(command=string(4))',
    result: 'boom',
    isError: true,
  }));
  assert.equal(failed.isError, true);
  assert.equal(failed.body, 'boom');

  // a chunk without an intent line still renders
  assert.deepEqual(parseToolChunk('just a body'), {
    intent: '', signature: '', calls: 1, isError: false, body: 'just a body',
  });
  assert.equal(parseToolChunk('').body, '');
});

test('a body that quotes the envelope still round-trips', () => {
  // exactly what read_file returns for a session file: the envelope as content
  const inner = formatMulticallEnvelope({ entries: [{ signature: 'a()', body: 'inner' }], calls: 1 });
  const chunk = formatToolResultChunk({
    intent: 'read a session',
    signature: 'read_file(path=string(9))',
    result: inner,
  });

  const parsed = parseToolChunk(chunk);
  assert.equal(parsed.body, inner, 'the nested envelope comes back byte-for-byte');
  assert.equal(parsed.signature, 'read_file(path=string(9))', 'the outer envelope is the one that counts');
});

test('an enveloped tool chunk replays as the plain body it wrapped', () => {
  // a batched conversation as it sits in a session file: the assistant chunk that
  // asked, then the stored result (docs/interface/session-replay replays it)
  const chunks = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [call('a', 'read_file', { path: 'fixture.txt', intent: 'load the fixture' })],
    },
    {
      role: 'tool',
      tool_call_id: 'a',
      content: formatToolResultChunk({
        intent: 'load the fixture',
        signature: 'read_file(path=string(11), intent=string(16))',
        result: 'line one\nline two',
        calls: 2,
      }),
    },
  ];

  const { ops, blocks } = replayChunks(chunks);
  assert.equal(blocks, 1);
  // the two `-> Calling …` lines come first, then the restored result
  assert.deepEqual(ops.map((op) => op.kind), ['log', 'log', 'block']);
  assert.equal(ops[2].header, '\n  [read_file Output] (intent: load the fixture) ✓');
  assert.equal(ops[2].body, 'line one\nline two', 'the envelope is unwrapped, not shown');
  assert.doesNotMatch(ops[2].body, /tool-multicall|tool-call name=/, 'no envelope syntax reaches the transcript');
});
