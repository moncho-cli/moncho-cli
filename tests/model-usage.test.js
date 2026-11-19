import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';

/**
 * Token usage per model (task-backlog: "within each session, we should be saving
 * token usage by model so we can have stats on the performance of the models").
 *
 * Proves the chain end to end:
 *  - the provider's counters are normalised from both response shapes, and a
 *    provider that reports none yields null instead of a fake zero;
 *  - the accounting table counts each call as exact or estimated and keys it by
 *    the model that answered;
 *  - the session file stores the table, and a file written before it existed
 *    still loads;
 *  - the live loop records every call, and `/usage` prints the breakdown.
 *
 * The environment is set before the dynamic imports because config/constants.js
 * reads it at module load; Node gives each test file its own process.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-model-usage-'));
process.chdir(root);
fs.writeFileSync('fixture.txt', 'fixture content\n', 'utf-8');
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:0/v1/chat/completions';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MODEL = 'stub-model';
process.env.CONTEXT_MAX_LENGTH = '100000';

/** A stub provider: counters on the first call only, so both paths are exercised. */
let calls = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    calls += 1;
    const parsed = JSON.parse(body);
    const hasTool = parsed.messages.some((message) => message.role === 'tool');
    const message = hasTool
      ? { role: 'assistant', content: 'all done' }
      : {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'fixture.txt', intent: 'load it' }) },
        }],
      };
    const payload = { choices: [{ message }] };
    if (calls === 1) payload.usage = { prompt_tokens: 111, completion_tokens: 22, total_tokens: 133 };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;

const { normalizeUsage } = await import('../api/ollama.js');
const {
  UNKNOWN_MODEL, emptyModelUsage, applyCall, applyTime, totalUsage, normalizeModelUsage,
  formatUsageRow, formatUsageRows, estimateCallUsage, recordProviderCall, createUsageMeter,
} = await import('../utils/usage-stats.js');
const {
  serializeSession, parseSession, formatSession, sessionUsage, writeSession, loadSession,
} = await import('../utils/session-store.js');
const { usageCommand, sessionsCommand, createCommandRegistry, runCommand } = await import('../app/commands.js');
const { loadTools } = await import('../utils/tool-loader.js');
const { ConversationManager } = await import('../app/conversation-manager.js');

const EXACT = { promptTokens: 100, completionTokens: 20, totalTokens: 120 };
const ZERO = emptyModelUsage();

test('normalizeUsage reads the OpenAI and Ollama counters and reports absence as null', () => {
  assert.deepEqual(
    normalizeUsage({ usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }),
    { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
  );
  // Ollama: flat counters, no total — it is summed, not left undefined
  assert.deepEqual(
    normalizeUsage({ prompt_eval_count: 40, eval_count: 8 }),
    { promptTokens: 40, completionTokens: 8, totalTokens: 48 },
  );
  assert.equal(normalizeUsage({ message: { usage: { prompt_tokens: 5, total_tokens: 99 } } }).totalTokens, 99);

  // nothing reported: null, so the caller knows the number would be a guess
  assert.equal(normalizeUsage({ choices: [{ message: { content: 'hi' } }] }), null);
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({}), null);
});

test('applyCall counts a call as exact or estimated and normalizeModelUsage repairs junk', () => {
  let entry = applyCall(ZERO, { usage: EXACT });
  assert.deepEqual(entry, {
    requests: 1, exactRequests: 1, estimatedRequests: 0,
    promptTokens: 100, completionTokens: 20, totalTokens: 120,
    // the working time rides the same entry (utils/working-time.js): a call that
    // never had a clock ticking on it simply reports zero milliseconds
    thinkingMs: 0, toolMs: 0,
  });

  // a call with no provider counters is counted, then flagged as an estimate
  entry = applyCall(entry, { estimated: { promptTokens: 10, completionTokens: 2 } });
  assert.equal(entry.requests, 2);
  assert.equal(entry.exactRequests, 1);
  assert.equal(entry.estimatedRequests, 1);
  assert.equal(entry.totalTokens, 132, 'prompt + completion when the estimate has no total');

  const table = normalizeModelUsage({
    'model b': entry,
    'model a': { requests: 1, promptTokens: 5, completionTokens: '7', totalTokens: -3 },
    '': { requests: 9 },                        // an unnamed entry is dropped
    broken: 'not an object',
    'model c': { requests: -2, promptTokens: 1.6 },
  });
  assert.deepEqual(Object.keys(table), ['model b', 'model a', 'broken', 'model c']);
  assert.deepEqual(table['model a'], { ...ZERO, requests: 1, promptTokens: 5, completionTokens: 7 });
  assert.deepEqual(table.broken, ZERO, 'a malformed entry becomes zeroes, never a throw');
  assert.equal(table['model c'].requests, 0, 'a negative counter is clamped');
  assert.equal(table['model c'].promptTokens, 2, 'a fractional counter is rounded');

  assert.deepEqual(normalizeModelUsage(null), {});
  assert.deepEqual(normalizeModelUsage([1, 2]), {});

  const totals = totalUsage(table);
  assert.equal(totals.models, 4);
  assert.equal(totals.requests, 3);
  assert.equal(totals.totalTokens, 132);
});

test('the estimate fallback is used when the provider reports no counters', () => {
  // 40 chars of answer / CHARS_PER_TOKEN (4) = 10 tokens
  assert.deepEqual(
    estimateCallUsage({ promptTokens: 50, completionText: 'x'.repeat(40) }),
    { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
  );

  const meter = createUsageMeter();
  recordProviderCall(meter, 'm', { response: { usage: EXACT }, promptTokens: 100 });
  recordProviderCall(meter, 'm', { response: { message: { content: 'x'.repeat(40) } }, promptTokens: 50 });
  const entry = meter.table().m;
  assert.equal(entry.requests, 2);
  assert.equal(entry.exactRequests, 1);
  assert.equal(entry.estimatedRequests, 1);
  assert.equal(entry.totalTokens, 180, '120 exact + 60 estimated');

  assert.equal(recordProviderCall(null, 'm', {}), null, 'no meter is a no-op, not a crash');
});

test('createUsageMeter keys the table by model and replace() makes a stored table live', () => {
  const meter = createUsageMeter();
  assert.deepEqual(meter.models, []);
  assert.deepEqual(meter.table(), {});

  meter.record('b-model', { usage: EXACT });
  meter.record('a-model', { usage: { promptTokens: 1, completionTokens: 1 } });
  meter.record('', { usage: EXACT });

  assert.deepEqual(meter.models, ['a-model', 'b-model', UNKNOWN_MODEL], 'alphabetical');
  assert.equal(meter.totals().models, 3);
  assert.equal(meter.totals().requests, 3);

  // a snapshot is a copy: later calls must not mutate what a caller stored
  const snapshot = meter.table();
  meter.record('a-model', { usage: EXACT });
  assert.equal(snapshot['a-model'].requests, 1);
  assert.equal(meter.table()['a-model'].requests, 2);

  const restored = meter.replace({ 'only-model': { requests: 7, totalTokens: 70 } });
  assert.deepEqual(meter.models, ['only-model']);
  assert.equal(restored['only-model'].requests, 7, 'resuming continues the counts');
  meter.replace({ 'only-model': { requests: 7, totalTokens: 70 } });
  assert.equal(meter.table()['only-model'].requests, 7, 'resuming twice does not double the table');

  assert.deepEqual(meter.reset(), {});
});

test('formatUsageRow/formatUsageRows describe the breakdown and an empty table says so', () => {
  const row = formatUsageRow('openai · gpt', {
    requests: 3, exactRequests: 2, estimatedRequests: 1,
    promptTokens: 1500, completionTokens: 500, totalTokens: 2000,
  });
  assert.match(row, /^openai · gpt — 3 request\(s\) \(2 exact, 1 estimated\)/);
  assert.match(row, /prompt 1\.50k · completion 500 · total 2\.00k$/);
  assert.match(formatUsageRow('m', { requests: 1, exactRequests: 1, totalTokens: 5 }), /\(all exact\)/);

  assert.deepEqual(formatUsageRows({}), ['No provider call has been recorded in this session yet.']);

  const lines = formatUsageRows({
    'b · model': { requests: 1, exactRequests: 1 },
    'a · model': { requests: 2, exactRequests: 2 },
  });
  assert.equal(lines.length, 4, 'a header, two models and a total');
  assert.match(lines[1], /^ {2}a · model —/, 'alphabetical, so two runs compare line by line');
  assert.match(lines.at(-1), /^ {2}total — 3 request\(s\)/);

  // one model needs no total line: it would just repeat the row
  assert.equal(formatUsageRows({ only: { requests: 1, exactRequests: 1 } }).length, 2);
});

test('applyTime/recordTime account the working time apart from the token counts', () => {
  // A call and a span are different units: a retried call is one request but
  // several thinking spans, so the two are counted by different functions.
  const entry = applyTime(applyCall(emptyModelUsage(), { usage: EXACT }), { thinkingMs: 4200, toolMs: 900 });
  assert.equal(entry.requests, 1);
  assert.equal(entry.totalTokens, 120);
  assert.equal(entry.thinkingMs, 4200);
  assert.equal(entry.toolMs, 900);

  // Junk is clamped like every other counter, never accumulated as NaN.
  assert.deepEqual(applyTime(ZERO, { thinkingMs: -5, toolMs: 'rubbish' }), ZERO);

  const meter = createUsageMeter();
  meter.record('m', { usage: EXACT });
  meter.recordTime('m', { thinkingMs: 1000 });
  meter.recordTime('m', { thinkingMs: 500, toolMs: 250 });
  meter.recordTime('', { toolMs: 10 });
  const row = meter.table().m;
  assert.equal(row.thinkingMs, 1500);
  assert.equal(row.toolMs, 250);
  assert.equal(meter.totals().thinkingMs, 1500);
  assert.equal(meter.table()[UNKNOWN_MODEL].toolMs, 10, 'an unnamed model still counts');

  // The row says nothing about time until there is some, then spells both halves.
  assert.doesNotMatch(formatUsageRow('m', { requests: 1, exactRequests: 1 }), /working/);
  assert.match(formatUsageRow('m', row), /working 2s \(thinking 2s, tools 0s\)/);
  assert.match(formatUsageRows({ m: row }).join('\n'), /working 2s/);
});

test('the session file stores the per-model table, and an older file without one still loads', () => {
  const usage = { 'ollama · qwen': { requests: 2, exactRequests: 1, estimatedRequests: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15, thinkingMs: 4200, toolMs: 900 } };
  const session = serializeSession({ createdAt: new Date('2026-02-14T10:30:00.000Z'), chunks: [], usage });
  assert.deepEqual(session.usage, usage, 'the table is part of the record');
  assert.deepEqual(parseSession(formatSession(session)).usage, usage, 'and survives the round-trip');
  assert.deepEqual(sessionUsage(session), usage);

  // a file written before the table existed is not refused: it simply has none
  const legacy = { version: 1, id: 'x', createdAt: '2026-02-14T10:30:00.000Z', chunks: [] };
  assert.deepEqual(parseSession(JSON.stringify(legacy)).usage, {}, 'an old session stays resumable');
  assert.deepEqual(sessionUsage({ ...legacy, usage: 'rubbish' }), {}, 'junk is repaired, never thrown');

  const dir = `agent/sessions-usage-${process.pid}`;
  try {
    writeSession({ createdAt: new Date('2026-02-14T10:30:00.000Z'), chunks: [], usage }, { dir });
    const stored = loadSession('2026-02-14T10-30-00-000Z', { dir });
    assert.deepEqual(sessionUsage(stored), usage, 'a resumed session reads its own counts back');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/usage prints the per-model breakdown, and resuming a session seeds the meter', async () => {
  assert.equal(await runCommand(createCommandRegistry(), 'usage', {}), null, 'an unknown command is not run');

  const usage = { 'openai · gpt': { requests: 2, exactRequests: 2, promptTokens: 30, completionTokens: 10, totalTokens: 40 } };
  const fromContext = await usageCommand().run({ usage });
  assert.equal(fromContext.code, 'USAGE');
  assert.match(fromContext.lines.join('\n'), /openai · gpt — 2 request\(s\) \(all exact\)/);

  const fromManager = await usageCommand().run({ manager: { usageTable: () => usage } });
  assert.deepEqual(fromManager.usage, normalizeModelUsage(usage), 'the live meter is the source');
  assert.deepEqual((await usageCommand().run({})).lines, ['No provider call has been recorded in this session yet.']);

  // resuming makes the session's table the live one: /usage continues the counts
  const dir = `agent/sessions-usage-resume-${process.pid}`;
  try {
    writeSession({ createdAt: new Date('2026-02-14T10:30:00.000Z'), chunks: [{ role: 'user', content: 'hi' }], usage }, { dir });
    const meter = createUsageMeter();
    const manager = { chunks: [], contextWindow: { replace: (next) => next.length }, usage: meter };
    const result = await sessionsCommand().run({ dir, manager, arg: '2026-02-14' });
    assert.equal(result.code, 'RESUMED');
    // the store normalises what it reads: a missing counter is an explicit zero
    const stored = normalizeModelUsage(usage);
    assert.deepEqual(result.usage, stored);
    assert.deepEqual(meter.table(), stored, 'the resumed counts are live, not added to an empty table');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the conversation loop records every call under the model that answered it', async () => {
  const { toolFunctions } = await loadTools(() => {});
  const manager = new ConversationManager(toolFunctions, () => [], () => null, {
    log: () => {},
    model: 'openai · stub-model',
  });

  await manager.processInput('read the fixture');

  const entry = manager.usageTable()['openai · stub-model'];
  assert.ok(entry, 'the model that answered is the key of the table');
  assert.equal(entry.requests, 2, 'the tool-call chunk and the reply were both billed');
  assert.equal(entry.exactRequests, 1, 'the counters the provider reported were used');
  assert.equal(entry.estimatedRequests, 1, 'the call without counters is flagged, not dropped');
  assert.equal(entry.promptTokens >= 111, true, 'the reported prompt tokens are in the table');
  assert.equal(totalUsage(manager.usageTable()).models, 1, 'one model answered, one entry');

  // a manager without a model still counts, under the placeholder key
  const anonymous = new ConversationManager(toolFunctions, () => [], () => null, { log: () => {} });
  anonymous.recordUsage({ usage: EXACT });
  assert.deepEqual(Object.keys(anonymous.usageTable()), [UNKNOWN_MODEL]);
  assert.equal(anonymous.usageTable()[UNKNOWN_MODEL].totalTokens, 120);
});

test.after(() => {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});