import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  analyzeToolPairing,
  buildProviderDiagnostic,
  describeRequestShape,
  extractProviderReason,
  formatProviderDiagnostic,
} from '../api/provider-analysis.js';
import { ProviderHttpError, readErrorBody, recordProviderFailure } from '../api/provider-diagnostics.js';
import { createLogger } from '../utils/logger.js';
import { registerLogger, clearLogger } from '../utils/host.js';

/**
 * The diagnosis of a provider call that failed.
 *
 * A provider refuses a request because of its *shape*, and its own body says why. The
 * harness used to throw the status away, so an operator had a number and nothing to act
 * on. These cases prove the three things the record has to carry:
 *
 *  - the **provider's reason**, extracted from every body shape in the wild;
 *  - the **shape of the request**, described without the conversation's words (the log
 *    is not a second transcript — `docs/runtime/logging`);
 *  - the **tool-call pairing**, which is what tells "the provider is broken" from "this
 *    session's history is broken" — a history whose `tool` messages no longer answer the
 *    calls above them is refused with a 400, and keeps being refused while a new session
 *    works.
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

test('the provider reason is read from every body shape in the wild', () => {
  // OpenAI-compatible: the shape most gateways answer with.
  assert.deepEqual(
    extractProviderReason(JSON.stringify({ error: { message: 'Invalid request', code: 'bad_request' } })),
    { reason: 'Invalid request', code: 'bad_request', body: '{"error":{"message":"Invalid request","code":"bad_request"}}' },
  );

  // Ollama answers with a plain string.
  assert.equal(
    extractProviderReason(JSON.stringify({ error: 'model requires more system memory' })).reason,
    'model requires more system memory',
  );

  // A bare text body is the reason itself.
  assert.equal(extractProviderReason('upstream connect error').reason, 'upstream connect error');

  // A body with no reason in it says so rather than inventing one.
  assert.equal(extractProviderReason('{}').reason, null);
  assert.equal(extractProviderReason('').reason, null);
});

test('the tool-call pairing names the calls that lost their result', () => {
  const balanced = analyzeToolPairing([
    { role: 'assistant', tool_calls: [{ id: 'call_a' }, { id: 'call_b' }] },
    { role: 'tool', tool_call_id: 'call_a', content: 'ok' },
    { role: 'tool', tool_call_id: 'call_b', content: 'ok' },
  ]);
  assert.equal(balanced.balanced, true);
  assert.equal(balanced.calls, 2);
  assert.equal(balanced.results, 2);

  // The failure this exists to find: the results of a batch were summarised away by a
  // compaction while the batch's own call message stayed.
  const broken = analyzeToolPairing([
    { role: 'assistant', tool_calls: [{ id: 'call_a' }, { id: 'call_b' }] },
    { role: 'tool', tool_call_id: 'call_a', content: 'ok' },
  ]);
  assert.equal(broken.balanced, false);
  assert.deepEqual(broken.unansweredCalls, ['call_b']);
  assert.deepEqual(broken.orphanResults, []);

  // The other way round: a result whose call was evicted.
  const orphaned = analyzeToolPairing([
    { role: 'tool', tool_call_id: 'call_a', content: 'ok' },
  ]);
  assert.deepEqual(orphaned.orphanResults, ['call_a']);
  assert.equal(orphaned.balanced, false);

  // Junk is an empty history, never a throw.
  assert.equal(analyzeToolPairing(null).balanced, true);
  assert.equal(analyzeToolPairing('nope').calls, 0);
});

test('the request is described by its shape, never by its words', () => {
  const shape = describeRequestShape([
    { role: 'system', content: 'the agent prompt' },
    { role: 'user', content: 'a secret the log must not copy' },
    { role: 'assistant', tool_calls: [{ id: 'call_a' }] },
    { role: 'tool', tool_call_id: 'call_a', content: 'the tool output' },
  ], [{ type: 'function' }]);

  assert.equal(shape.messages, 4);
  assert.equal(shape.roles.system, 1);
  assert.equal(shape.roles.user, 1);
  assert.equal(shape.roles.assistant, 1);
  assert.equal(shape.roles.tool, 1);
  assert.equal(shape.tools, 1);
  assert.ok(shape.contentBytes > 0);

  // The words of the conversation are nowhere in the shape.
  const serialized = JSON.stringify(shape);
  assert.ok(!serialized.includes('a secret the log must not copy'), 'the conversation must not be copied into the log');
  assert.ok(!serialized.includes('the tool output'), 'the tool output must not be copied into the log');

  // What the diagnosis needs is there: the role of each message and the call ids.
  assert.equal(shape.lastMessages.at(-1).tool_call_id, 'call_a');
  assert.equal(shape.lastMessages.at(-2).tool_calls[0], 'call_a');
});

test('the diagnostic carries the status, the reason and the pairing', () => {
  const diagnostic = buildProviderDiagnostic({
    response: { status: 400, statusText: 'Bad Request' },
    body: JSON.stringify({ error: { message: "messages with role 'tool' must be a response to a preceding message with 'tool_calls'" } }),
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'call_a' }] },
    ],
    tools: [],
    stream: false,
    url: 'http://provider/v1/chat/completions',
    model: 'stub-model',
  });

  assert.equal(diagnostic.status, 400);
  assert.match(diagnostic.reason, /must be a response to a preceding message/);
  assert.equal(diagnostic.pairing.balanced, false);
  assert.deepEqual(diagnostic.pairing.unansweredCalls, ['call_a']);
  assert.equal(diagnostic.model, 'stub-model');

  const summary = formatProviderDiagnostic(diagnostic);
  assert.match(summary, /provider answered 400/);
  assert.match(summary, /must be a response to a preceding message/);
  assert.match(summary, /tool calls unanswered: 1/);
});

test('a non-200 is recorded in the log with the provider reason and the pairing', async () => {
  const file = tempLogFile('provider-failure');
  const logger = createLogger({ file, level: 'info' });
  registerLogger(logger);

  try {
    const error = await recordProviderFailure({
      response: {
        status: 400,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({ error: { message: 'context length exceeded' } }),
      },
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', tool_calls: [{ id: 'call_a' }] },
      ],
      tools: [{ type: 'function' }],
      stream: false,
      url: 'http://provider/v1/chat/completions',
      model: 'stub-model',
      attempt: 1,
      maxRetries: 3,
    });

    // The error the call raises carries the provider's own reason, and its status.
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.status, 400);
    assert.match(error.message, /400/);
    assert.match(error.message, /context length exceeded/);

    const written = readLines(file);
    assert.equal(written.length, 1, 'one line for the failed attempt');
    assert.ok(written[0].includes('WARN  [provider]'), 'a retried attempt is a warning');
    assert.match(written[0], /provider answered 400: context length exceeded/);

    // The record carries the pairing analysis — the finding that matters.
    assert.match(written[0], /"unansweredCalls":\["call_a"\]/);
    assert.match(written[0], /"orphanResults":\[\]/);
    assert.match(written[0], /"status":400/);

    // ...and never the conversation.
    assert.ok(!written[0].includes('hello'), 'the log is not a second transcript');
    assert.equal(logger.getFailure(), null, 'every write landed');
  } finally {
    clearLogger();
  }

  cleanup(file);
});

test('the last attempt is an error, and an unreadable body never throws', async () => {
  const file = tempLogFile('provider-last-attempt');
  const logger = createLogger({ file, level: 'info' });
  registerLogger(logger);

  try {
    const error = await recordProviderFailure({
      response: {
        status: 503,
        statusText: 'Service Unavailable',
        // A body that cannot be read must not lose the record.
        text: async () => { throw new Error('connection reset'); },
      },
      messages: [{ role: 'user', content: 'hello' }],
      attempt: 3,
      maxRetries: 3,
    });

    assert.equal(error.status, 503);
    const written = readLines(file);
    assert.ok(written[0].includes('ERROR [provider]'), 'the last attempt is an error');
    assert.match(written[0], /provider answered 503/);
  } finally {
    clearLogger();
  }

  cleanup(file);
});

test('an error body is read within its cap, and a missing one is empty', async () => {
  const body = await readErrorBody({ text: async () => 'x'.repeat(10000) });
  assert.ok(body.length < 10000, 'the body is bounded');
  assert.match(body, /truncated/);

  assert.equal(await readErrorBody({ text: async () => { throw new Error('boom'); } }), '');
  assert.equal(await readErrorBody(null), '');
  assert.equal(await readErrorBody({}), '');
});
