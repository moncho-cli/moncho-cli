import test from 'node:test';
import assert from 'node:assert/strict';

import { createCommandRegistry, createDefaultCommands, runCommand } from '../app/commands.js';
import { compactCommand, FORCE_ARG } from '../app/compact-command.js';

/**
 * `/compact` — the compaction the *user* asks for.
 *
 * The window compacts itself when a turn pushes it past its budget, and the model can
 * ask for one through the `compact_context` tool; this command is the third way in, and
 * it reaches the very same state: `ConversationManager#maybeCompact()`. The cases here
 * drive the command against a stub manager, so they prove the wiring, the honest
 * reporting of "nothing to compact" and the pulse reset — never a provider.
 */

/** A manager stand-in: the command only reaches maybeCompact and resetPulse. */
function fakeManager(result, { throws = null } = {}) {
  const calls = [];
  const resets = [];
  return {
    calls,
    resets,
    async maybeCompact(signal, options = {}) {
      calls.push({ signal, options });
      if (throws) throw throws;
      return result;
    },
    resetPulse: (reason) => resets.push(reason),
  };
}

/** A registry holding just /compact. */
function registry() {
  const commands = createCommandRegistry();
  commands.register(compactCommand());
  return commands;
}

test('/compact runs the ordinary budget check and reports a window that still fits', async () => {
  const manager = fakeManager({ compacted: false, reason: 'within-budget', usage: '1.2k / 8.0k tokens (15%)' });

  const result = await runCommand(registry(), 'compact', { manager });

  assert.equal(result.ok, true);
  assert.equal(result.code, 'WITHIN_BUDGET');
  assert.equal(result.compacted, false);
  assert.equal(result.usage, '1.2k / 8.0k tokens (15%)');
  assert.deepEqual(manager.calls[0].options, { force: false, reason: 'user-request' });
  assert.equal(manager.calls[0].signal, null, 'a user-driven compaction has no abort signal of its own');
  assert.deepEqual(manager.resets, [], 'nothing compacted, so the pulse is untouched');
  assert.match(result.message, /within budget/);
  assert.match(result.message, /\/compact force/, 'the user is told how to override the budget');
});

test('/compact force overrides the budget and restarts the pulse', async () => {
  const manager = fakeManager({
    compacted: true,
    olderChunks: 4,
    keptChunks: 3,
    carriedChunks: 1,
    afterTokens: 900,
    usage: '900 / 8.0k tokens (11%)',
  });

  const result = await runCommand(registry(), 'compact', { arg: FORCE_ARG, manager });

  assert.equal(result.code, 'COMPACTED');
  assert.equal(result.compacted, true);
  assert.equal(result.olderChunks, 4);
  assert.equal(result.keptChunks, 3);
  assert.equal(result.carriedChunks, 1);
  assert.equal(result.afterTokens, 900);
  assert.equal(result.pulseReset, true);
  assert.deepEqual(manager.calls[0].options, { force: true, reason: 'user-request' });
  assert.deepEqual(manager.resets, ['compaction'], 'a user-driven compaction is the same event as a forced one');
  assert.match(result.message, /4 older chunk\(s\)/);
  assert.match(result.message, /900 \/ 8\.0k tokens/);
});

test('/compact over a window with nothing to compact says so instead of failing', async () => {
  const manager = fakeManager({ compacted: false, reason: 'nothing_to_compact' });

  const result = await runCommand(registry(), 'compact', { arg: 'force', manager });

  assert.equal(result.ok, true);
  assert.equal(result.code, 'WITHIN_BUDGET');
  assert.equal(result.reason, 'nothing_to_compact');
  assert.equal(result.pulseReset, undefined, 'nothing was rewritten, so nothing is reset');
  assert.match(result.message, /nothing to compact/i);
});

test('/compact refuses a front end without a window, an unknown argument and a failed compaction', async () => {
  const noWindow = await runCommand(registry(), 'compact', {});
  assert.equal(noWindow.ok, false);
  assert.equal(noWindow.code, 'NO_CONTEXT_WINDOW');

  const unknown = await runCommand(registry(), 'compact', { arg: 'now', manager: fakeManager({ compacted: false }) });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'UNKNOWN_ARG');
  assert.match(unknown.message, /\/compact force/);

  // The runner contains a failure and reports it as a reason (a compaction must never
  // break the task), so the command turns it into its own refusal rather than claiming
  // the window was rewritten.
  const failed = await runCommand(registry(), 'compact', {
    arg: 'force',
    manager: fakeManager({ compacted: false, reason: 'error', error: 'the summariser returned nothing' }),
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'COMPACTION_FAILED');
  assert.match(failed.message, /window is unchanged/);
  assert.match(failed.message, /summariser returned nothing/);

  const threw = await runCommand(registry(), 'compact', {
    manager: fakeManager(null, { throws: new Error('no provider') }),
  });
  assert.equal(threw.ok, false);
  assert.equal(threw.code, 'COMPACTION_FAILED');
  assert.match(threw.message, /no provider/);
});

test('/compact ships in the default registry, so the user can type it', async () => {
  const commands = createDefaultCommands();

  assert.equal(commands.get('compact').name, 'compact');
  assert.ok(commands.list().some((command) => command.name === 'compact'));

  const help = await runCommand(commands, 'help', {});
  assert.ok(help.lines.some((line) => line.startsWith('/compact — compact the context window now')));
});
