import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  REPLAY_REPLY_HEADER,
  REPLAY_REPLY_FOOTER,
  UNKNOWN_TOOL_NAME,
  formatCompactedNotice,
  replayChunks,
  renderReplay,
  reloadConversation,
} from '../app/session-replay.js';
import { createSessionRecorder } from '../app/session-recorder.js';
import { sessionsCommand, createDefaultCommands, runCommand } from '../app/commands.js';
import { writeSession, loadSession } from '../utils/session-store.js';
import { createCommandRegistry } from '../app/commands.js';
import { withTui, visible } from './support/tui-harness.js';

/**
 * Reloading a stored conversation (task-backlog: "when i open a previous
 * session, the conversation should be reloaded as it was left in that session").
 *
 * Resuming used to restore the *context window* only, so the model remembered the
 * conversation while the transcript stayed empty. These cases prove that the
 * chunks are turned back into the display the live loop produced for them — the
 * user echo, the tool calls with their intents, the collapsible results, the
 * assistant prose and a compaction notice — and that a resumed session keeps
 * being saved into the file it came from.
 */

const flush = async (rounds = 3) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A conversation as it looks in a session file: every role, in order. */
const CHUNKS = [
  { role: 'user', content: 'read the fixture' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: 'call_0',
      type: 'function',
      function: {
        name: 'read_file',
        arguments: JSON.stringify({ path: 'fixture.txt', intent: 'load the fixture' }),
      },
    }],
  },
  { role: 'tool', tool_call_id: 'call_0', content: 'intent: load the fixture\nline one\nline two\nline three' },
  { role: 'assistant', content: 'All done: the file holds one line.' },
];

function tempDir(name) {
  const dir = `agent/sessions-replay-${process.pid}-${name}`;
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

const textOf = (ops) => ops.map((op) => (op.kind === 'block' ? `${op.header}\n${op.body}` : op.text)).join('\n');

test('replayChunks() rebuilds the dialogue the live loop had written', () => {
  const { ops, calls, blocks, notices, skipped } = replayChunks(CHUNKS);

  assert.deepEqual(ops, [
    { kind: 'log', text: 'You:\n> read the fixture' },
    { kind: 'log', text: '\n  -> Calling read_file(path: fixture.txt, intent: load the fixture)' },
    { kind: 'log', text: '     intent: load the fixture' },
    { kind: 'block', header: '\n  [read_file Output] (intent: load the fixture)', body: 'line one\nline two\nline three' },
    { kind: 'log', text: `${REPLAY_REPLY_HEADER}\nAll done: the file holds one line.\n${REPLAY_REPLY_FOOTER}` },
  ]);
  assert.equal(calls, 1);
  assert.equal(blocks, 1);
  assert.equal(notices, 0);
  assert.equal(skipped, 0, 'every chunk of this conversation renders');

  // the user's own message comes back as the echo, not as raw prose
  assert.match(textOf(ops), /^You:\n> read the fixture/);
  // the tool result is a block, so it is collapsible rather than plain text
  assert.equal(ops[3].body, 'line one\nline two\nline three', 'the intent is unwrapped from the body');
});

test('the tool name is recovered from the call the result answers', () => {
  // the tool chunk records the call id only, so the name comes from the
  // assistant chunk that asked for it
  const { ops } = replayChunks(CHUNKS);
  assert.match(ops[3].header, /\[read_file Output\]/);

  // two calls answered out of order: one result each, named from its own call
  const outOfOrder = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'a', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'x', intent: 'search' }) } },
        { id: 'b', function: { name: 'blob', arguments: JSON.stringify({ path: 'app', intent: 'read' }) } },
      ],
    },
    { role: 'tool', tool_call_id: 'b', content: 'intent: read\nblob body' },
    { role: 'tool', tool_call_id: 'a', content: 'intent: search\ngrep body' },
  ];
  const headers = replayChunks(outOfOrder).ops.filter((op) => op.kind === 'block').map((op) => op.header);
  assert.deepEqual(headers, [
    '\n  [grep Output] (intent: search)',
    '\n  [blob Output] (intent: read)',
  ], 'each block sits next to the call it answers, in call order');
});

test('a chunk list that does not match a live session still replays', () => {
  // no recorded call for the result, a summarised chunk, a stray role and an
  // empty assistant turn: each must render or be skipped, never throw
  const { ops, notices, skipped } = replayChunks([
    { role: 'tool', tool_call_id: 'gone', content: 'intent: orphan\norphan body' },
    { role: 'system', content: '[compacted summary of earlier context]\nsummary text', compacted: true, summarized_chunks: 7 },
    { role: 'assistant', content: '   ' },
    { role: 'weird', content: 'nope' },
    null,
  ]);

  assert.deepEqual(ops[0], {
    kind: 'block',
    header: `\n  [${UNKNOWN_TOOL_NAME} Output] (intent: orphan)`,
    body: 'orphan body',
  }, 'an unmatched result renders under a generic name');
  assert.equal(ops[1].text, formatCompactedNotice({ summarized_chunks: 7 }));
  assert.match(ops[1].text, /7 chunk\(s\) summarised/);
  assert.equal(notices, 1);
  assert.equal(skipped, 3, 'the empty reply, the unknown role and null are skipped');
  assert.deepEqual(replayChunks().ops, []);
  assert.deepEqual(replayChunks(null).ops, []);
});

test('a failed tool result keeps its error marker out of the body', () => {
  const chunks = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c', function: { name: 'run_bash', arguments: JSON.stringify({ command: 'ls nope', intent: 'list' }) } }],
    },
    { role: 'tool', tool_call_id: 'c', content: 'intent: list\n[error] Error executing run_bash: boom' },
  ];
  const { ops } = replayChunks(chunks);
  assert.equal(ops[2].body, 'Error executing run_bash: boom');
  assert.match(ops[1].text, /intent: list/);
});

test('renderReplay() drives a block-aware front end and a plain one', () => {
  const { ops } = replayChunks(CHUNKS);

  const tuiCalls = [];
  renderReplay(ops, {
    log: (text) => tuiCalls.push(['log', text]),
    logBlock: ({ header, body }) => tuiCalls.push(['block', header, body]),
  });
  assert.deepEqual(tuiCalls.map((entry) => entry[0]), ['log', 'log', 'log', 'block', 'log']);
  assert.deepEqual(tuiCalls[3], ['block', '\n  [read_file Output] (intent: load the fixture)', 'line one\nline two\nline three']);

  // the line CLI has no widget: a block is printed header, body, blank line —
  // exactly how main.js echoes a live tool result there
  const cliCalls = [];
  renderReplay(ops, { log: (...args) => cliCalls.push(args.join(' ')) });
  assert.deepEqual(cliCalls.slice(3, 6), [
    '\n  [read_file Output] (intent: load the fixture)',
    'line one\nline two\nline three',
    '',
  ]);
  assert.equal(renderReplay(ops, {}), 0, 'without a logger nothing is rendered');
});

test('reloadConversation() empties the view before it replays the session', () => {
  const calls = [];
  const report = reloadConversation(CHUNKS, {
    clear: () => calls.push('clear'),
    log: (text) => calls.push(['log', text]),
    logBlock: (block) => calls.push(['block', block.header]),
  });

  assert.equal(calls[0], 'clear', 'the previous conversation is dropped first');
  assert.equal(report.calls, 1);
  assert.equal(report.blocks, 1);
  assert.equal(calls.length, 6, 'one clear plus five rendered entries');
});

test('opening a session in the TUI reloads the conversation on screen', async () => {
  await withTui(async (tui) => {
    // a conversation already on screen, then the user resumes another one
    tui.log('previous conversation');
    await flush();
    assert.match(visible(tui), /previous conversation/);

    tui.reload(CHUNKS);
    await flush();

    const text = visible(tui);
    assert.doesNotMatch(text, /previous conversation/, 'the old transcript is replaced');
    assert.match(text, /You:/);
    assert.match(text, /│ read the fixture/, 'the user message is echoed as a quote');
    assert.match(text, /-> Calling read_file\(path: fixture\.txt, intent: load the fixture\)/);
    assert.match(text, /intent: load the fixture/);
    assert.match(text, /\[read_file Output\] \(intent: load the fixture\)/);
    assert.match(text, /All done: the file holds one line\./);
    assert.doesNotMatch(text, /-fg\}/, 'no blessed tag leaks as text');

    // a restored tool result is a real block: it can be expanded and collapsed
    assert.equal(tui.blocks.length, 1);
    const block = tui.blocks[0];
    assert.equal(block.collapsed, true);
    assert.equal(block.body, 'line one\nline two\nline three');
    tui.toggleBlock(block.id);
    await flush();
    assert.equal(block.collapsed, false);
    assert.match(visible(tui), /line one/);
  });
});

test('resuming keeps saving into the session it opened', async () => {
  const dir = tempDir('adopt');
  try {
    writeSession({
      createdAt: new Date('2026-02-14T10:00:00.000Z'),
      chunks: CHUNKS,
      model: 'openrouter · test/model',
    }, { dir });

    const recorder = createSessionRecorder({ dir, now: () => new Date('2026-02-20T09:00:00.000Z') });
    assert.notEqual(recorder.id, '2026-02-14T10-00-00-000Z', 'a fresh run starts a new file');

    // what the host does with the RESUMED result: reload the view and adopt the id
    const manager = {
      chunks: [],
      contextWindow: { replace: (next) => { manager.chunks = [...next]; } },
    };
    const registry = createCommandRegistry();
    registry.register(sessionsCommand());
    const result = await runCommand(registry, 'sessions', { dir, manager, arg: '2026-02-14' });

    assert.equal(result.code, 'RESUMED');
    assert.equal(result.resumed.id, '2026-02-14T10-00-00-000Z');
    assert.deepEqual(result.resumed.chunks, CHUNKS, 'the chunks to reload come back with the result');
    assert.equal(result.resumed.createdAt, '2026-02-14T10:00:00.000Z');

    recorder.adopt(result.resumed.id, {
      createdAt: result.resumed.createdAt,
      model: result.resumed.model,
    });
    assert.equal(recorder.id, '2026-02-14T10-00-00-000Z');
    assert.equal(recorder.startedAt, '2026-02-14T10:00:00.000Z', 'the conversation start date is kept');

    // the next turn overwrites the file the user picked, not a new one
    recorder.save([...CHUNKS, { role: 'user', content: 'and now?' }], { reason: 'turn' });
    const stored = loadSession('2026-02-14T10-00-00-000Z', { dir });
    assert.equal(stored.chunks.length, 5);
    assert.equal(stored.createdAt, '2026-02-14T10:00:00.000Z');
    assert.deepEqual(
      fs.readdirSync(dir).sort(),
      ['2026-02-14T10-00-00-000Z'],
      'no parallel session folder is left behind',
    );

    assert.throws(() => recorder.adopt(''), /requires a session id/);
  } finally {
    cleanup(dir);
  }
});

test('a resumed conversation still answers commands and reaches /help', async () => {
  const registry = createDefaultCommands();
  assert.equal(registry.get('resume').name, 'sessions');
  const help = await runCommand(registry, 'help', {});
  assert.ok(help.lines.some((line) => line.startsWith('/sessions — list stored conversations')));
});
