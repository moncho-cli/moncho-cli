import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  createCommandRegistry,
  createDefaultCommands,
  parseCommand,
  runCommand,
  sessionsCommand,
} from '../app/commands.js';
import { createPicker, DEFAULT_PAGE_SIZE } from '../app/picker.js';
import { writeSession } from '../utils/session-store.js';

const CHUNKS = [
  { role: 'system', content: 'you are moncho' },
  { role: 'user', content: 'read the fixture' },
  { role: 'assistant', content: 'all done' },
];

function tempDir(name) {
  const dir = `agent/sessions-cmd-${process.pid}-${name}`;
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

/** A registry holding just /sessions, for the command tests. */
function sessionsRegistry() {
  const registry = createCommandRegistry();
  registry.register(sessionsCommand());
  return registry;
}

/** A context window stand-in, so the command can be tested without a provider. */
function fakeManager() {
  let chunks = [];
  return {
    get chunks() {
      return chunks;
    },
    contextWindow: {
      replace(next) {
        chunks = [...next];
        return chunks.length;
      },
    },
  };
}

test('parseCommand() recognises /<name> <arg> and leaves prompts alone', () => {
  assert.deepEqual(parseCommand('/sessions'), { name: 'sessions', arg: '' });
  assert.deepEqual(parseCommand('/sessions 2026-02-14T10-30-00-000Z'), {
    name: 'sessions',
    arg: '2026-02-14T10-30-00-000Z',
  });
  assert.deepEqual(parseCommand('  /HELP  me  '), { name: 'help', arg: 'me' });
  assert.deepEqual(parseCommand('/sessions\nmore'), { name: 'sessions', arg: 'more' });

  // anything that is not a command stays a prompt
  assert.equal(parseCommand('hello'), null);
  assert.equal(parseCommand(''), null);
  assert.equal(parseCommand('/'), null, 'a bare slash is not a command');
  assert.equal(parseCommand('/ spaced'), null);
  assert.equal(parseCommand('see /sessions for details'), null);
});

test('the command registry is iterable code, not a hard-coded switch', async () => {
  const registry = createCommandRegistry();
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.has('nope'), false);
  assert.equal(await runCommand(registry, 'nope', {}), null, 'an unknown command is not run');

  const calls = [];
  registry.register({
    name: 'echo',
    description: 'repeat the argument',
    aliases: ['say'],
    run: (ctx) => {
      calls.push(ctx.arg);
      return { ok: true, code: 'ECHO', message: ctx.arg };
    },
  });

  assert.equal(registry.has('echo'), true);
  assert.equal(registry.has('say'), true, 'aliases resolve to the same command');
  assert.equal(registry.get('ECHO').name, 'echo');
  assert.deepEqual(registry.list().map((command) => command.name), ['echo']);

  const result = await runCommand(registry, 'say', { arg: 'hi' });
  assert.deepEqual(result, { ok: true, code: 'ECHO', message: 'hi' });
  assert.deepEqual(calls, ['hi'], 'the context reaches the command');

  assert.throws(() => registry.register({}), /needs a name/);
  assert.throws(() => registry.register({ name: 'x' }), /needs a run/);
});

test('the default registry ships /work, /new, /sessions, /usage, /compact, /skins and /help, and /help lists them', async () => {
  const registry = createDefaultCommands();
  assert.deepEqual(registry.list().map((command) => command.name), ['compact', 'help', 'new', 'sessions', 'skins', 'usage', 'work']);
  assert.equal(registry.get('resume').name, 'sessions', 'the alias is registered');

  const help = await runCommand(registry, 'help', {});
  assert.equal(help.code, 'HELP');
  assert.deepEqual(help.lines, [
    '/compact — compact the context window now (/compact force to compact within budget)',
    '/help — list the available commands',
    '/new — start a new session (the current conversation stays on disk for /sessions)',
    '/sessions — list stored conversations and continue one',
    "/skins — manage the project's colour palette and presentation (/skins prompt <request> for a new skin, /skins customize <request> to adjust the active one)",
    '/usage — token usage per model in this session',
    '/work — turn the execution lock on or off (/work on, /work off)',
  ]);
});

test('/sessions with no stored session says so and changes nothing', async () => {
  const dir = tempDir('empty');
  try {
    const manager = fakeManager();
    const result = await runCommand(createDefaultCommands(), 'sessions', { dir, manager });
    assert.equal(result.ok, true);
    assert.equal(result.code, 'NO_SESSIONS');
    assert.equal(manager.chunks.length, 0);
  } finally {
    cleanup(dir);
  }
});

test('/sessions lists the stored conversations when there is no picker', async () => {
  const dir = tempDir('list');
  try {
    writeSession({ createdAt: new Date('2026-02-14T10:00:00.000Z'), chunks: CHUNKS }, { dir });
    const result = await runCommand(sessionsRegistry(), 'sessions', { dir });

    assert.equal(result.code, 'LISTED');
    assert.equal(result.sessions.length, 1);
    // The command returns what to print; the host formats it (a JSON payload
    // would be pretty-printed there, never here).
    assert.equal(result.lines.length, 1);
    assert.match(result.lines[0], /2026-02-14T10-00-00-000Z — 1 turn\(s\), 3 chunk\(s\)/);
  } finally {
    cleanup(dir);
  }
});

test('/sessions opens the picker and resumes the chosen conversation', async () => {
  const dir = tempDir('pick');
  try {
    writeSession({ createdAt: new Date('2026-02-14T10:00:00.000Z'), chunks: CHUNKS }, { dir });
    writeSession({
      createdAt: new Date('2026-02-15T10:00:00.000Z'),
      chunks: [...CHUNKS, { role: 'user', content: 'later' }],
    }, { dir });

    const manager = fakeManager();
    let offered = null;
    const result = await runCommand(sessionsRegistry(), 'sessions', {
      dir,
      manager,
      choose: async (labels, options) => {
        offered = { labels, options };
        return 0; // the newest session (listSessions sorts newest first)
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.code, 'RESUMED');
    assert.equal(result.id, '2026-02-15T10-00-00-000Z');
    assert.equal(result.chunks, 4);
    assert.equal(offered.options.title, 'Sessions');
    assert.equal(offered.labels.length, 2);
    assert.deepEqual(
      manager.chunks,
      [...CHUNKS, { role: 'user', content: 'later' }],
      'the window holds the session again',
    );
  } finally {
    cleanup(dir);
  }
});

test('/sessions cancels cleanly, and refuses an unknown id or a broken file', async () => {
  const dir = tempDir('cancel');
  try {
    writeSession({ createdAt: new Date('2026-02-14T10:00:00.000Z'), chunks: CHUNKS }, { dir });
    const manager = fakeManager();
    const registry = sessionsRegistry();

    const cancelled = await runCommand(registry, 'sessions', {
      dir, manager, choose: async () => null,
    });
    assert.equal(cancelled.code, 'CANCELLED');
    assert.equal(manager.chunks.length, 0, 'a cancelled pick changes nothing');

    const unknown = await runCommand(registry, 'sessions', { dir, manager, arg: 'nope' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, 'UNKNOWN_SESSION');

    fs.writeFileSync(`${dir}/broken.json`, '{not json');
    const broken = await runCommand(registry, 'sessions', { dir, manager, arg: 'broken' });
    assert.equal(broken.ok, false);
    assert.equal(broken.code, 'UNREADABLE');
  } finally {
    cleanup(dir);
  }
});

test('/sessions <id> resumes directly, without a picker', async () => {
  const dir = tempDir('direct');
  try {
    writeSession({ createdAt: new Date('2026-02-14T10:00:00.000Z'), chunks: CHUNKS }, { dir });
    const manager = fakeManager();
    const result = await runCommand(sessionsRegistry(), 'sessions', {
      dir,
      manager,
      arg: '2026-02-14',
      choose: async () => {
        throw new Error('the picker must not open for an explicit id');
      },
    });

    assert.equal(result.code, 'RESUMED');
    assert.equal(result.id, '2026-02-14T10-00-00-000Z');
    assert.deepEqual(manager.chunks, CHUNKS);
  } finally {
    cleanup(dir);
  }
});

test('createPicker() keeps the cursor in view and wraps at the ends', () => {
  const items = Array.from({ length: 20 }, (_, i) => `session ${i}`);
  const picker = createPicker({ items });

  assert.equal(picker.pageSize, DEFAULT_PAGE_SIZE);
  assert.equal(picker.current(), 'session 0');
  assert.equal(picker.move(1), 'session 1');
  assert.equal(picker.move(-1), 'session 0');
  assert.equal(picker.move(-1), 'session 19', 'moving up from the top wraps');
  assert.equal(picker.move(1), 'session 0', 'moving down from the bottom wraps');
  assert.equal(picker.moveTo(7), 'session 7');
  assert.equal(picker.moveToEnd(), 'session 19');
  assert.equal(picker.moveTo(999), 'session 19', 'an out-of-range jump is clamped');
  assert.equal(picker.moveTo(-5), 'session 0');

  // the window follows the cursor and never overflows the page size
  picker.moveToEnd();
  const rows = picker.window();
  assert.equal(rows.length, DEFAULT_PAGE_SIZE);
  assert.equal(rows.filter((row) => row.selected).length, 1);
  assert.equal(rows.at(-1).item, 'session 19');
  assert.equal(rows.at(-1).selected, true);

  picker.moveTo(0);
  const lines = picker.lines();
  assert.equal(lines.length, DEFAULT_PAGE_SIZE);
  assert.ok(lines[0].startsWith('> '), 'the highlighted row carries the marker');
  assert.ok(lines[1].startsWith('  '));
});

test('createPicker() handles an empty list without throwing', () => {
  const picker = createPicker({ items: [] });
  assert.equal(picker.current(), null);
  assert.equal(picker.move(1), null);
  assert.deepEqual(picker.window(), []);
  assert.deepEqual(picker.lines(), ['(nothing to select)']);
  assert.deepEqual(picker.lines({ empty: 'no sessions' }), ['no sessions']);
  assert.equal(createPicker({ items: ['a', 'b'], pageSize: 0 }).pageSize, DEFAULT_PAGE_SIZE);
});
