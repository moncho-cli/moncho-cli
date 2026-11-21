import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { newCommand } from '../app/new-command.js';
import { createDefaultCommands } from '../app/commands.js';
import { handleCommand } from '../app/session-loop.js';
import { createSessionMode, MODES } from '../app/session-mode.js';
import { createSessionRecorder } from '../app/session-recorder.js';
import { ContextWindow } from '../app/context-window.js';
import { createUsageMeter } from '../utils/usage-stats.js';
import { clearSession, registerSession } from '../utils/host.js';

/**
 * `/new` — start a fresh conversation without leaving the process (backlog #71).
 *
 * The command owns the *manager* half of the reset (the live window and the accounting
 * table); the host owns the identity half (a fresh session id, a new pair of tracking
 * files, an emptied view). These cases prove both, and that the previous conversation is
 * left on disk rather than deleted.
 */

/** A manager stub with a real window and a real usage table. */
function stubManager() {
  const contextWindow = new ContextWindow({ maxTokens: 1000 });
  contextWindow.add({ role: 'user', content: 'old question' });
  contextWindow.add({ role: 'assistant', content: 'old answer' });
  const usage = createUsageMeter();
  usage.record('test-model · 1', { promptTokens: 10, completionTokens: 5 });

  const pulseResets = [];
  return {
    contextWindow,
    usage,
    pulseResets,
    resetPulse: (reason) => pulseResets.push(reason),
  };
}

test('/new ships in the default registry, so the user can type it', () => {
  const registry = createDefaultCommands();
  assert.ok(registry.has('new'));
  assert.ok(registry.helpLines().some((line) => line.startsWith('/new —')));
});

test('/new empties the live window, the accounting table and the pulse', () => {
  const manager = stubManager();
  const result = newCommand().run({ manager });

  assert.equal(result.ok, true);
  assert.equal(result.code, 'NEW_SESSION');
  assert.equal(manager.contextWindow.length, 0, 'the window is empty');
  assert.equal(manager.contextWindow.journal.length, 0, 'and so is the uncompacted history');
  assert.deepEqual(manager.usage.table(), {}, 'the accounting table starts from zero');
  assert.deepEqual(manager.pulseResets, ['new-session'], 'the call pulse restarts');
});

test('/new refuses an argument and a front end with no window', () => {
  const manager = stubManager();
  const withArg = newCommand().run({ manager, arg: 'sneaky' });
  assert.equal(withArg.ok, false);
  assert.equal(withArg.code, 'UNKNOWN_ARG');
  // A refused `/new` moves nothing: a typo must never reset the conversation.
  assert.equal(manager.contextWindow.length, 2);

  const noWindow = newCommand().run({ manager: {} });
  assert.equal(noWindow.ok, false);
  assert.equal(noWindow.code, 'NO_CONTEXT_WINDOW');
});

test('handleCommand() rotates the session identity to a brand-new id', async () => {
  const manager = stubManager();
  const registry = createDefaultCommands();
  const logged = [];
  const reloads = [];
  const tokens = [];
  const sessions = createSessionRecorder({
    model: 'test-model · 1',
    stateOf: () => ({ mode: MODES.WORK, work: false }),
    id: 'before-rotation',
  });
  const previousId = sessions.id;
  const previousPath = sessions.path;
  let rotations = 0;
  const rotate = sessions.rotate.bind(sessions);
  sessions.rotate = () => { rotations += 1; return rotate(); };

  try {
    registerSession(sessions);
    const consumed = await handleCommand('/new', {
      commands: registry,
      log: (line) => logged.push(line),
      manager,
      sessions,
      tui: { reload: (chunks, options) => reloads.push({ chunks, options }), setTokens: (u) => tokens.push(u) },
    });

    assert.equal(consumed, true, 'a command never reaches the model');
    assert.equal(rotations, 1, 'the recorder was asked for a fresh identity exactly once');
    assert.notEqual(sessions.id, previousId, 'the id really moved');
    assert.notEqual(sessions.path, previousPath, 'and so did the session path');
    assert.ok(sessions.path.includes(sessions.id), 'the path names the new id');
    assert.deepEqual(reloads, [{ chunks: [], options: {} }], 'the view is emptied');
    assert.equal(tokens.length, 1, 'the meter is repainted from the emptied window');
    assert.ok(logged.some((line) => line.includes('Started a new session')), 'the result is printed');
    assert.ok(logged.some((line) => line.includes(sessions.id)), 'and it names the new session');
  } finally {
    clearSession();
    // The session folders this case named live in the project tree; remove both by id,
    // so a test never leaves state behind.
    for (const id of [previousId, sessions.id]) {
      fs.rmSync(path.join(process.cwd(), 'agent/sessions', id), { recursive: true, force: true });
    }
  }
});

test('a line CLI without reload() still empties the window and prints the result', async () => {
  const manager = stubManager();
  const logged = [];
  const consumed = await handleCommand('/new', {
    commands: createDefaultCommands(),
    log: (line) => logged.push(line),
    manager,
  });

  assert.equal(consumed, true);
  assert.equal(manager.contextWindow.length, 0);
  assert.ok(logged.length > 0, 'the result reached the line sink');
});

test.after(() => { clearSession(); });
