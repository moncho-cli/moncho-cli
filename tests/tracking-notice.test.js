import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  formatTrackingUpdate, createTrackingNotifier, TRACKING_NOTICE_PREFIX,
} from '../app/tracking-notice.js';
import {
  CONVERSATION_COLORS, TRACKING_COLOR, TRACKING_BOLD, classifyLine, colorizeLine,
} from '../app/theme.js';
import {
  registerSession, registerTrackingNotifier, notifyTrackingUpdate,
  clearSession, clearTrackingNotifier,
} from '../utils/host.js';
import { execute as updateTaskExecute } from '../tools/update_task.js';
import { withTui, visible } from './support/tui-harness.js';

/**
 * The transcript announcement of a tracking update.
 *
 * `update_task` rewrites the two tracking files from inside a tool call, and the user
 * watches the conversation rather than the files, so every write that means something
 * (an item completed, a plan reset, a step ticked, the status line moved) shows up as a
 * `[Tracking]` row in the palette's own bright-green + bold. Two halves are proven here:
 *  - the wording and the wiring (`formatTrackingUpdate`, `notifyTrackingUpdate`), and
 *  - the colour really reaching the terminal, distinct from every other kind of row,
 *    while the announcement stays presentation only (no chunk, no session file, and a
 *    bare tool call with no front end registered is a no-op).
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-tracking-notice-test-'));
process.chdir(root);

const ID = 's1';
const FOLDER = `agent/sessions/${ID}`;
const TASK = '# Task list\n\nstatus: pending\n\n## Items\n\n- [ ] item one\n- [ ] item two\n';
const PLAN = '# item one\n\nstatus: in progress\n\n## Steps\n\n- [ ] step a\n- [ ] step b\n';

function writeFile(name, content) {
  fs.mkdirSync(path.dirname(name), { recursive: true });
  fs.writeFileSync(name, content, 'utf-8');
}

const read = (name) => fs.readFileSync(name, 'utf-8');

test.afterEach(() => {
  clearSession();
  clearTrackingNotifier();
  fs.rmSync(path.join(root, 'agent'), { recursive: true, force: true });
});

test('a tracking update becomes its own contrasting [Tracking] row', () => {
  // The colour is a kind of its own, and it is not one of the rows it sits next to.
  assert.equal(TRACKING_COLOR, CONVERSATION_COLORS.tracking);
  assert.equal(TRACKING_COLOR, 'bright-green');
  assert.equal(TRACKING_BOLD, true);
  for (const other of ['tool', 'context', 'error', 'notice', 'user']) {
    assert.notEqual(TRACKING_COLOR, CONVERSATION_COLORS[other], `tracking must not read as ${other}`);
  }

  // The row is recognised by its prefix and painted with the style in one place.
  assert.equal(classifyLine('[Tracking] task.md · "one" done'), 'tracking');
  assert.equal(
    colorizeLine('[Tracking] task.md · "one" done'),
    '{bright-green-fg}{bold}[Tracking] task.md · "one" done{/bold}{/bright-green-fg}',
  );
  // ...and only the exact label counts: prose that mentions tracking is prose.
  assert.equal(classifyLine('the tracking of this row is unclear'), null);
  assert.equal(classifyLine('[Info] nothing happened'), 'notice');
});

test('formatTrackingUpdate() says what changed, in the file that changed', () => {
  const completed = formatTrackingUpdate({
    action: 'complete',
    completed: 'item one',
    next: 'item two',
    progress: { total: 3, done: 1 },
    planTarget: 'item two',
    planSteps: 2,
  });
  assert.equal(completed.length, 2, 'the checklist line and the plan line');
  assert.equal(completed[0], `${TRACKING_NOTICE_PREFIX} task.md · "item one" done — 1/3 items, next: "item two"`);
  assert.equal(completed[1], `${TRACKING_NOTICE_PREFIX} implementation_plan.md · reset for "item two" — 2 steps queued`);

  // The last item closes the checklist instead of naming a next one.
  const last = formatTrackingUpdate({ action: 'complete', completed: 'item three', progress: { total: 3, done: 3 } });
  assert.match(last[0], /checklist finished$/);

  // A ticked step is announced on the plan's own line, with its progress.
  assert.deepEqual(formatTrackingUpdate({ action: 'step', step: 'step a', plan: { total: 2, done: 1 } }), [
    `${TRACKING_NOTICE_PREFIX} implementation_plan.md · step "step a" ticked — 1/2 steps`,
  ]);

  // The metadata-only paths: a status edit, and starting an item.
  assert.deepEqual(formatTrackingUpdate({ action: 'status', status: 'in progress: item two' }), [
    `${TRACKING_NOTICE_PREFIX} task.md · status: in progress: item two`,
  ]);
  assert.deepEqual(formatTrackingUpdate({ action: 'start', next: 'item two', progress: { total: 2, done: 1 } }), [
    `${TRACKING_NOTICE_PREFIX} task.md · working on "item two" — 1/2 items done`,
  ]);

  // Nothing worth announcing is silence, never an empty row.
  assert.deepEqual(formatTrackingUpdate({ action: 'list' }), []);
  assert.deepEqual(formatTrackingUpdate({}), []);
  assert.deepEqual(formatTrackingUpdate(), []);

  // A one-step plan is singular, and a multi-line item is flattened to one row.
  assert.match(formatTrackingUpdate({ action: 'start', next: 'a\nb', planTarget: 'a\nb', planSteps: 1 })[1], /1 step queued$/);
  const flattened = formatTrackingUpdate({ action: 'complete', completed: 'two\nlines', progress: { total: 1, done: 1 } });
  assert.equal(flattened[0].includes('\n'), false, 'one row per announcement');
});

test('a completed item and a ticked step really reach the transcript', async () => {
  writeFile(`${FOLDER}/task.md`, TASK);
  writeFile(`${FOLDER}/implementation_plan.md`, PLAN);
  registerSession({ id: ID });

  const shown = [];
  registerTrackingNotifier(createTrackingNotifier({ log: (line) => shown.push(line) }));

  const done = JSON.parse(await updateTaskExecute({
    action: 'complete', item: 'item one', steps: ['step a'], intent: 'finish item one',
  }));
  assert.equal(done.status, 'success');
  assert.deepEqual(done.trackingLines, [
    `${TRACKING_NOTICE_PREFIX} task.md · "item one" done — 1/2 items, next: "item two"`,
    `${TRACKING_NOTICE_PREFIX} implementation_plan.md · reset for "item two" — 1 step queued`,
  ]);

  const ticked = JSON.parse(await updateTaskExecute({ action: 'step', step: 'step a', intent: 'tick step a' }));
  assert.equal(ticked.status, 'success');
  assert.deepEqual(ticked.trackingLines, [
    `${TRACKING_NOTICE_PREFIX} implementation_plan.md · step "step a" ticked — 1/1 steps`,
  ]);

  // What was logged is what was reported, in order, and every row classifies as tracking.
  assert.deepEqual(shown, [...done.trackingLines, ...ticked.trackingLines]);
  for (const line of shown) assert.equal(classifyLine(line), 'tracking');

  // A refusal never announces anything, because nothing was written.
  const refused = JSON.parse(await updateTaskExecute({ action: 'complete', item: 'nope', intent: 'x' }));
  assert.equal(refused.code, 'ITEM_NOT_FOUND');
  assert.equal(refused.trackingLines, undefined);
  assert.equal(shown.length, 3, 'a refusal adds no row');
});

test('the announcement is presentation only: no chunk, no file, no front end needed', async () => {
  writeFile(`${FOLDER}/task.md`, TASK);
  writeFile(`${FOLDER}/implementation_plan.md`, PLAN);
  registerSession({ id: ID });

  // With no sink registered the report is a no-op, never an error: this is the bare
  // tool call the tool-level suites drive.
  clearTrackingNotifier();
  assert.deepEqual(notifyTrackingUpdate({ action: 'complete', completed: 'x' }), []);

  const done = JSON.parse(await updateTaskExecute({ action: 'complete', item: 'item one', intent: 'x' }));
  assert.deepEqual(done.trackingLines, []);

  // The files on disk carry the announcement nowhere: the row is not a document.
  assert.doesNotMatch(read(`${FOLDER}/task.md`), /\[Tracking\]/);
  assert.doesNotMatch(read(`${FOLDER}/implementation_plan.md`), /\[Tracking\]/);
});

test('the tracking row is painted bright green on the real screen', async () => {
  await withTui(async (tui) => {
    const line = formatTrackingUpdate({
      action: 'complete', completed: 'item one', progress: { total: 2, done: 1 }, next: 'item two',
    })[0];

    // The transcript view runs formatTranscript() itself, so the raw line goes in and
    // comes back coloured exactly once.
    tui.log(line);
    await new Promise((resolve) => setImmediate(resolve));

    const text = visible(tui);
    assert.match(text, /\[Tracking\] task\.md · "item one" done — 1\/2 items, next: "item two"/);
    assert.doesNotMatch(text, /-fg\}/, 'the tag resolved instead of being printed');
    assert.doesNotMatch(text, /bright-green/, 'no blessed tag leaks as text');

    // The colour really reaches the terminal: bright green (92) and bold (1) — never the
    // yellow of a tool row or the magenta of a context notice.
    const frame = tui.transcript.getContent();
    const at = frame.indexOf('[Tracking]');
    assert.ok(at >= 0, 'the row is on screen');
    assert.match(frame.slice(Math.max(0, at - 24), at), /\x1b\[(?:1;92|92|1;32|32)m/, 'the row is bright green');
  });
});
