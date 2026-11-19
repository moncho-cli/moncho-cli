import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '../utils/logger.js';
import { registerLogger, clearLogger } from '../utils/host.js';
import { runTurn } from '../app/turn-runner.js';
import { ContextWindow } from '../app/context-window.js';
import { dispatchToolCalls } from '../app/tool-batch.js';

/**
 * The operational log at its real call sites.
 *
 * `tests/logging.test.js` proves the rules (levels, threshold, line shape, rotation,
 * the no-throw sink). This file proves the *wiring*: the deep modules reach the
 * logger through the host registry, the events an operator actually goes looking for
 * are the ones recorded, and recording them changes nothing about the outcome the
 * caller sees.
 */

/** A throw-away log directory inside the project (cleaned up afterwards). */
function tempLogFile(name) {
  const dir = `agent/logs-test-${process.pid}-${name}`;
  fs.rmSync(dir, { recursive: true, force: true });
  return `${dir}/moncho.log`;
}

function cleanup(file) {
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

function readLines(file) {
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
}

/** The session `runTurn()` touches, as a plain object (see tests/turn-runner.test.js). */
function createSession(overrides = {}) {
  const lines = [];
  return {
    lines,
    session: {
      contextWindow: new ContextWindow({ maxTokens: 1000, tools: () => [] }),
      getTools: () => [],
      getAbortSignal: () => null,
      log: (line) => lines.push(String(line)),
      notifyContextChange: () => {},
      notifyNotice: () => {},
      beginModelCall: () => [],
      formatFailure: (error) => `Provider call failed: ${error.message}`,
      recordUsage: () => {},
      resetPulse: () => {},
      maybeCompact: async () => null,
      handleToolCalls: async () => false,
      handleFinalResponse: async () => {},
      ...overrides,
    },
  };
}

test('a provider failure and a throwing tool are recorded without changing the outcome', async () => {
  const file = tempLogFile('call-sites');
  const logger = createLogger({ file, level: 'info' });
  registerLogger(logger);

  try {
    // 1. The failure that ends a turn: the transcript line stays, and the log keeps
    //    the stack the transcript never shows.
    const { session, lines } = createSession({
      callModel: async () => { throw new Error('connect ECONNREFUSED'); },
    });

    assert.deepEqual(await runTurn(session, 'go'), { ended: 'error' });
    assert.match(lines.join('\n'), /Error calling Ollama: connect ECONNREFUSED/, 'the transcript is unchanged');

    // 2. A tool that throws still answers with an `[error]` chunk, and the log holds
    //    the stack behind that one-line message.
    const [outcome] = await dispatchToolCalls(
      [{ call: { id: 'call_1', name: 'boom', args: {}, rawArgs: '{}', intent: 'probe' } }],
      { boom: async () => { throw new Error('tool exploded'); } },
    );
    assert.equal(outcome.isError, true, 'a throwing tool is still an outcome, never a rejection');
    assert.equal(outcome.result, 'Error executing boom: tool exploded');

    const written = readLines(file);
    assert.ok(written.some((line) => line.includes('ERROR [provider] provider call failed')), 'the turn-ending failure is an error line');
    assert.ok(written.some((line) => line.includes('"message":"connect ECONNREFUSED"')), 'the line carries the details');
    assert.ok(written.some((line) => line.includes('WARN  [tool] tool boom threw')), 'the throwing tool is a warning line');
    assert.equal(logger.getFailure(), null, 'every write landed');
  } finally {
    clearLogger();
  }

  cleanup(file);
});

test('an aborted call is recorded as info, below an error threshold', async () => {
  const file = tempLogFile('abort');
  const logger = createLogger({ file, level: 'error' });
  registerLogger(logger);

  try {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { session } = createSession({ callModel: async () => { throw abort; } });

    assert.deepEqual(await runTurn(session, 'abort me'), { ended: 'abort' });
    assert.equal(fs.existsSync(file), false, 'an info line is not written under an error threshold');
  } finally {
    clearLogger();
  }

  cleanup(file);
});

test('the log is written through the path sandbox, so it cannot escape the project', () => {
  clearLogger();
  const logger = createLogger({ file: '../outside.log', level: 'info' });

  assert.equal(logger.info('startup', 'refused'), null);
  assert.match(logger.getFailure()?.message ?? '', /escapes the project directory/);
  assert.equal(fs.existsSync('../outside.log'), false);
});
