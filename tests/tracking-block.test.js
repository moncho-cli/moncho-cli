import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  TRACKING_BLOCK_COLOR,
  TRACKING_BLOCK_TITLES,
  trackingKindsWritten,
  formatTrackingBlock,
  createTrackingBlockSink,
  createTrackingAnnouncer,
} from '../app/tracking-block.js';
import { TRACKING_COLOR, classifyLine, setPalette, resetTheme } from '../app/theme.js';
import { registerSession, clearSession } from '../utils/host.js';
import { withTui, visible } from './support/tui-harness.js';

/**
 * The TUI-only block that shows the *content* of a tracking write
 * (`docs/interface/tracking-block`).
 *
 * The `[Tracking]` rows (`tests/tracking-notice.test.js`) say what happened; this suite
 * proves the second half of the announcement: the full content of the file that changed,
 * in the tracking colour, with a title — and that it is shown **only** where a block sink
 * exists, i.e. never on the line CLI.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-tracking-block-test-'));
process.chdir(root);

const ID = 's1';
const FOLDER = `agent/sessions/${ID}`;
const TASK = '# Task list\n\nstatus: pending\n\n## Items\n\n- [ ] item one\n';
const PLAN = '# item one\n\nstatus: in progress\n\n## Steps\n\n- [ ] step a\n';

function writeFile(name, content) {
  fs.mkdirSync(path.dirname(name), { recursive: true });
  fs.writeFileSync(name, content, 'utf-8');
}

/** A reader that hands back the files this suite wrote, verbatim. */
const read = (kind) => (kind === 'task' ? TASK : PLAN);

test.afterEach(() => {
  clearSession();
  fs.rmSync(path.join(root, 'agent'), { recursive: true, force: true });
});

test('only the files a write really touched get a block, in the protocol order', () => {
  assert.equal(TRACKING_BLOCK_COLOR, TRACKING_COLOR, 'the block borrows the tracking colour');
  assert.deepEqual(TRACKING_BLOCK_TITLES, { task: 'task.md', plan: 'implementation_plan.md' });

  // The tools report which file they wrote; that report is the only input.
  assert.deepEqual(trackingKindsWritten({ taskWritten: true, planWritten: true }), ['task', 'plan']);
  assert.deepEqual(trackingKindsWritten({ planWritten: true }), ['plan']);
  assert.deepEqual(trackingKindsWritten({ taskWritten: true }), ['task']);
  // A refusal (`ITEM_NOT_FOUND`) writes nothing, so it shows nothing.
  assert.deepEqual(trackingKindsWritten({ action: 'complete' }), []);
  assert.deepEqual(trackingKindsWritten({}), []);
  assert.deepEqual(trackingKindsWritten(), []);
});

test('the block is titled, carries the full content verbatim, and paints it tracking', () => {
  const block = formatTrackingBlock({ kind: 'task', content: TASK, path: `${FOLDER}/task.md` });

  // The title names the file, where it lives, and how much content it holds.
  assert.match(block.header, /^\[Tracking\] task\.md \(agent\/sessions\/s1\/task\.md\) · full content — 7 lines$/);
  // The `[Tracking]` label is what makes the palette paint the header in that colour...
  assert.equal(classifyLine(block.header), 'tracking');
  // ...and `bodyColor` is what paints the payload, through app/transcript-view.js#logBlock.
  assert.equal(block.bodyColor, TRACKING_COLOR);
  assert.equal(classifyLine(block.body.split('\n')[0]), null, 'the payload is not reclassified');

  // Verbatim: every line of the file, minus the trailing newline of the last one only.
  assert.equal(block.body, TASK, 'the bytes of the file, verbatim, trailing newline included');
  assert.equal(block.collapsed, false, 'the point of the block is that the content is visible');

  // The plan gets its own title, and a one-line file is singular.
  const plan = formatTrackingBlock({ kind: 'plan', content: '# item one\n' });
  assert.match(plan.header, /^\[Tracking\] implementation_plan\.md · full content — 1 line$/);
  assert.equal(plan.body, '# item one\n', 'verbatim, the trailing newline included');
  assert.equal(plan.bodyColor, TRACKING_COLOR, 'the plan block is painted the same way');

  // An empty file still answers, and says so instead of showing nothing at all.
  const empty = formatTrackingBlock({ kind: 'task', content: '' });
  assert.match(empty.header, /— 0 lines$/);
  assert.equal(empty.body, '(empty)');
  // An unknown kind still produces a titled block, never a row reading "undefined".
  assert.match(formatTrackingBlock({}).header, /^\[Tracking\] tracking file · full content — 0 lines$/);
});

test('the block is shown only where a block sink exists, so the line CLI is unchanged', () => {
  const update = { taskWritten: true, planWritten: true };

  // No sink: nothing is built, nothing is shown. This is the line CLI.
  const bare = createTrackingBlockSink({ read });
  assert.deepEqual(bare.notify(update), []);
  assert.equal(bare.shown, 0);
  // The blocks the update *would* produce are still readable, for a caller that asks.
  assert.equal(bare.blocks(update).length, 2);

  // With a sink, one block per written file, in order, each already formatted.
  const shown = [];
  const sink = createTrackingBlockSink({ logBlock: (block) => shown.push(block), read });
  const built = sink.notify(update);
  assert.equal(built.length, 2);
  assert.deepEqual(shown, built);
  assert.equal(sink.shown, 2);
  assert.match(shown[0].header, /task\.md/);
  assert.match(shown[1].header, /implementation_plan\.md/);
  assert.equal(shown[0].body, TASK);
  assert.equal(shown[1].body, PLAN);

  // A ticked step moves no checklist, so no task block is built for it.
  assert.deepEqual(sink.notify({ planWritten: true, action: 'step' }).map((b) => b.header.includes('task.md')), [false]);
  // ...and a write that touched nothing shows nothing at all.
  assert.deepEqual(sink.notify({ action: 'list' }), []);
  assert.equal(sink.shown, 3, 'the two first blocks and the plan one');
});

test('the announcer shows the rows and the content together, from one call', () => {
  const lines = [];
  const blocks = [];
  const announcer = createTrackingAnnouncer({
    log: (line) => lines.push(line),
    logBlock: (block) => blocks.push(block),
    read,
  });

  const update = {
    action: 'complete',
    completed: 'item one',
    progress: { total: 2, done: 1 },
    next: 'item two',
    planTarget: 'item two',
    planSteps: 1,
    taskWritten: true,
    planWritten: true,
  };
  const rows = announcer.notify(update);

  // The rows are what they always were, and the blocks follow them.
  assert.equal(rows.length, 2);
  assert.deepEqual(lines, rows);
  assert.equal(blocks.length, 2);
  assert.equal(announcer.announced, 1);
  assert.equal(announcer.blockSink.shown, 2);

  // With no block sink the rows are the whole announcement, which is the line CLI.
  const cliLines = [];
  const cli = createTrackingAnnouncer({ log: (line) => cliLines.push(line), read });
  assert.equal(cli.notify(update).length, 2);
  assert.deepEqual(cliLines, rows);
  assert.equal(cli.blockSink.shown, 0, 'no block without a widget for one');
});

test('the content is read back from disk, so a canonical rewrite is what is shown', () => {
  writeFile(`${FOLDER}/task.md`, TASK);
  registerSession({ id: ID });

  const shown = [];
  // The default reader goes through utils/tracking-store.js, i.e. the session's own files.
  const sink = createTrackingBlockSink({ logBlock: (block) => shown.push(block) });

  sink.notify({ taskWritten: true });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].body, TASK, 'the bytes on disk are the ones shown');
  assert.match(shown[0].header, new RegExp(`\\(${FOLDER}/task\\.md\\)`));

  // A write that touched no file shows nothing at all.
  assert.deepEqual(sink.notify({ action: 'list' }), []);
  assert.equal(shown.length, 1);

  // The plan's own write shows the plan's own bytes, and never the task's with it.
  writeFile(`${FOLDER}/implementation_plan.md`, PLAN);
  const plan = sink.notify({ planWritten: true });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].body, PLAN);
  assert.equal(plan[0].header.includes('task.md'), false);
});

test('the block really reaches the screen, expanded, in the tracking colour', async () => {
  await withTui(async (tui) => {
    const block = formatTrackingBlock({ kind: 'task', content: TASK, path: `${FOLDER}/task.md` });
    tui.logBlock(block);
    await new Promise((resolve) => setImmediate(resolve));

    // The whole file is on screen — the block is not collapsed — and no tag leaks as text.
    const text = visible(tui);
    assert.match(text, /\[Tracking\] task\.md/);
    assert.match(text, /full content — 7 lines/);
    assert.match(text, /\[ \] item one/);
    assert.doesNotMatch(text, /-fg\}/, 'the tag resolved instead of being printed');
    assert.doesNotMatch(text, /bright-green/, 'no blessed tag leaks as text');

    // The payload is painted bright green (92), like the milestones beside it.
    const frame = tui.transcript.getContent();
    const at = frame.indexOf('status: pending');
    assert.ok(at >= 0, 'a content line is on screen');
    assert.match(frame.slice(Math.max(0, at - 20), at), /\x1b\[(?:1;92|92|1;32|32)m/, 'the content is bright green');
  });
});

test('the block reads the live tracking colour, so a skin repaints its payload', () => {
  // The regression this pins: `export const TRACKING_BLOCK_COLOR = TRACKING_COLOR` took the
  // colour at import, so a skin that moved `tracking` repainted the `[Tracking]` rows and
  // left the block below them in the shipped green.
  try {
    setPalette({ tracking: 'red' });
    const block = formatTrackingBlock({ kind: 'task', content: TASK, path: `${FOLDER}/task.md` });
    assert.equal(block.bodyColor, 'red', 'the block body follows the live palette');

    resetTheme();
    const shipped = formatTrackingBlock({ kind: 'task', content: TASK, path: `${FOLDER}/task.md` });
    assert.equal(shipped.bodyColor, TRACKING_COLOR, 'and returns to the shipped colour');
  } finally {
    resetTheme();
  }
});
