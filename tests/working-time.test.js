import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORK_KINDS, WORK_TICK_MS, formatDuration, formatWorkRow, createWorkingClock,
} from '../utils/working-time.js';
import { createWorkRow } from '../app/work-row.js';
import { createStatusRows } from '../app/status-rows.js';
import { composeStatusRow } from '../app/tui-render.js';
import { ConversationManager } from '../app/conversation-manager.js';
import { ContextWindow } from '../app/context-window.js';

/**
 * The working-time counter (task-backlog: "add working time counter to sessions,
 * show next avobe the token window size information row, also aligned to the
 * right ... save this also in the usage stats, dont send any of this to the
 * model").
 *
 * Three layers, each proved on its own: the pure clock and its two formatters, the
 * row that paints them, and the conversation manager that feeds both — the last
 * one is the only place where "time is accounted but never sent" can be checked.
 */

/** A clock whose time only moves when the test moves it. */
function fakeClock({ tickMs = 1000 } = {}) {
  let now = 0;
  const armed = [];
  const clock = createWorkingClock({
    now: () => now,
    tickMs,
    arm: (fn) => {
      armed.push(fn);
      return { unref() {} };
    },
    disarm: () => {},
  });
  return {
    clock,
    armed,
    advance: (ms) => { now += ms; },
    tick: () => armed.forEach((fn) => fn()),
  };
}

test('formatDuration() spells a short, a medium and a long span', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(192_000), '3m 12s');
  // Past an hour the seconds are dropped and the minutes are padded, so the row
  // keeps one width while it climbs.
  assert.equal(formatDuration(3_720_000), '1h 02m');
  // Junk and negatives are 0s, never NaN.
  assert.equal(formatDuration(-5), '0s');
  assert.equal(formatDuration('rubbish'), '0s');
  assert.equal(formatDuration(undefined), '0s');
});

test('formatWorkRow() says nothing until the session has worked', () => {
  assert.equal(formatWorkRow({ thinkingMs: 0, toolMs: 0 }), '');
  assert.equal(formatWorkRow({}), '');
  assert.equal(formatWorkRow(), '');
  // A total that is already computed is used as-is; otherwise the two halves add up.
  assert.equal(formatWorkRow({ thinkingMs: 30_000, toolMs: 15_000 }), 'working 45s');
  assert.equal(formatWorkRow({ totalMs: 90_000, thinkingMs: 0, toolMs: 0 }), 'working 1m 30s');
});

test('createWorkingClock() counts only thinking and tool spans', () => {
  const { clock, advance, tick } = fakeClock();
  const seen = [];
  clock.subscribe((totals) => seen.push(totals));

  assert.deepEqual(WORK_KINDS, ['thinking', 'tool']);
  assert.equal(clock.isWorking(), false);

  // A thinking span and a tool span, both open at once: the two counters are kept
  // apart. openTotals() measures against the clock's "now", so each open span
  // reports the time elapsed since it was opened.
  const thinking = clock.begin('thinking');
  advance(2_000);
  const tool = clock.begin('tool');
  advance(1_000);

  assert.equal(clock.isWorking(), true);
  assert.deepEqual(clock.openTotals(), { thinkingMs: 3_000, toolMs: 1_000, totalMs: 4_000 });

  // The tick repaints while a span is open: the row climbs instead of jumping.
  advance(1_000);
  tick();
  assert.deepEqual(seen.at(-1), { thinkingMs: 4_000, toolMs: 2_000, totalMs: 6_000 });

  // Closing reports the span's own duration and leaves the other one running.
  assert.equal(clock.end(thinking), 4_000);
  assert.equal(clock.end(tool), 2_000);
  assert.equal(clock.isWorking(), false);
  assert.deepEqual(clock.openTotals(), { thinkingMs: 0, toolMs: 0, totalMs: 0 });
  // A span that was never opened costs nothing.
  assert.equal(clock.end(undefined), 0);
  clock.close();
});

test('createWorkingClock() arms one timer and reports its own tick length', () => {
  const { clock, armed } = fakeClock();
  assert.equal(WORK_TICK_MS, 1000);
  clock.begin('thinking');
  clock.begin('tool');
  // One timer for the clock, not one per span: two open spans still tick once.
  assert.equal(armed.length, 1);
  clock.close();
});

test('createWorkRow() right-aligns the counter and paints nothing while idle', () => {
  const painted = [];
  const row = createWorkRow({ paint: (line) => painted.push(line), width: () => 40 });

  assert.equal(row.render(), '');
  assert.equal(painted.at(-1), '');

  row.setTotals({ thinkingMs: 30_000, toolMs: 15_000 });
  const expected = composeStatusRow('', 'working 45s', 40);
  assert.equal(row.line, 'working 45s');
  assert.equal(row.render(), expected);
  assert.equal(painted.at(-1), expected);
  // Right-aligned: the text ends at the last column and the row is padded on the left.
  assert.equal(expected.length, 40);
  assert.ok(expected.endsWith('working 45s'));
  assert.equal(row.totals.thinkingMs, 30_000);
});

test('createStatusRows() keeps the counter and the meter on one width', () => {
  const painted = { status: [], work: [] };
  const rows = createStatusRows({
    paintStatus: (line) => painted.status.push(line),
    paintWork: (line) => painted.work.push(line),
    width: () => 40,
    initialStatus: 'Ready',
  });

  // A fresh pair: the meter row has its status, the counter row is empty.
  rows.render();
  assert.equal(painted.status.at(-1), 'Ready');
  assert.equal(painted.work.at(-1), '');

  rows.setWork({ thinkingMs: 5_000, toolMs: 0 });
  assert.equal(painted.work.at(-1), composeStatusRow('', 'working 5s', 40));

  // The meter is still painted by the same pair, unchanged.
  rows.statusRow.setMeter('12%');
  assert.equal(painted.status.at(-1), composeStatusRow('Ready', '12%', 40));

  rows.dispose();
});

test('the manager times the model call and the tool batch into the usage table', async () => {
  const { clock, advance } = fakeClock();
  const manager = new ConversationManager(
    // The tool itself is what takes time: the span is opened around the batch.
    { probe: async () => { advance(1_000); return 'probe output'; } },
    () => [],
    () => null,
    {
      log: () => {},
      model: 'stub · model',
      working: clock,
      contextWindow: new ContextWindow({ maxTokens: 100_000 }),
      // The provider call is a stub: what is under test is the timing around it.
      callModel: async () => {
        advance(4_000);
        return { message: { content: 'answer' } };
      },
    },
  );

  await manager.callModel([], [], null, {});
  await manager.handleToolCalls(
    [{ id: 'call_1', type: 'function', function: { name: 'probe', arguments: '{"intent":"timing"}' } }],
    null,
  );

  const entry = manager.usage.table()['stub · model'];
  assert.ok(entry, 'the time lands under the model that did the work');
  assert.equal(entry.thinkingMs, 4_000, 'the model call is a thinking span');
  assert.equal(entry.toolMs, 1_000, 'the tool batch is a tool span');

  // What the row paints is the accounted time plus whatever is still open.
  const totals = manager.workingTotals();
  assert.equal(totals.thinkingMs, 4_000);
  assert.equal(totals.totalMs, 5_000);
  assert.equal(manager.working.isWorking(), false, 'both spans were closed');
  clock.close();
});

test('the time never reaches the context window', async () => {
  const { clock } = fakeClock();
  const window = new ContextWindow({ maxTokens: 100_000 });
  const manager = new ConversationManager({}, () => [], () => null, {
    log: () => {},
    model: 'stub · model',
    working: clock,
    contextWindow: window,
    callModel: async () => ({ message: { content: 'answer' } }),
  });

  await manager.callModel([], [], null, {});
  const serialised = JSON.stringify(window.chunks);
  assert.doesNotMatch(serialised, /thinkingMs|toolMs|working/);
  assert.equal(window.chunks.length, 0, 'the clock appends no chunk of its own');
  clock.close();
});
