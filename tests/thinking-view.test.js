import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readThinkingCapture, thinkingDocuments, thinkingView,
  thinkingHitZone, clickedThinkingLabel, bindThinkingClick,
  THINKING_VIEW_TITLE,
} from '../app/thinking-view.js';
import { createStatusRow } from '../app/status-row.js';
import { normalizeResponse } from '../api/provider-response.js';
import { composeStatusRow, sanitize } from '../app/tui-render.js';
import { withTui } from './support/tui-harness.js';

/**
 * The `Thinking` label as a door onto the reasoning stream (`docs/interface/thinking-view`).
 *
 * Three layers are proven apart: the reader is forgiving by construction, the hit
 * zone repeats the composer's arithmetic rather than approximating it, and the binder
 * is checked for the three moments that matter — between turns nothing happens, a hit
 * opens the surface's own viewer, and anything that throws is reported rather than
 * thrown into the click.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-thinking-view-'));
process.chdir(root);

const flush = () => new Promise((resolve) => setImmediate(resolve));

test.afterEach(() => {
  fs.rmSync(path.join(root, 'agent'), { recursive: true, force: true });
});

/** A capture file the tests can point at, whatever the environment says. */
const writeCapture = (text, name = 'agent/thinking.md') => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf-8');
  return name;
};

test('a missing capture is no view, and no error', () => {
  assert.equal(readThinkingCapture({ file: 'agent/never-written.md' }), null);
  assert.equal(thinkingView({ file: 'agent/never-written.md' }), null);
});

test('a capture outside the project is refused rather than read', () => {
  assert.equal(readThinkingCapture({ file: '/etc/passwd' }), null);
});

test('an empty capture is no document, so a click before the first delta opens nothing', () => {
  const file = writeCapture('   \n\n');
  assert.deepEqual(thinkingDocuments(readThinkingCapture({ file })), []);
  assert.equal(thinkingView({ file }), null);
});

test('a capture with text becomes one document, and the reload re-reads it', () => {
  const file = writeCapture('first thought\n');
  const view = thinkingView({ file });
  assert.equal(view.title, THINKING_VIEW_TITLE);
  assert.equal(view.documents.length, 1);
  assert.equal(view.documents[0].text, 'first thought\n');

  // The stream is written *while* the box is open: the reload is what makes it live.
  fs.writeFileSync(path.join(root, file), 'first thought\nsecond thought\n', 'utf-8');
  assert.match(view.reload()[0].text, /second thought/);
});

test('the hit zone is the painted left slot, never a wider guess', () => {
  const left = 'Thinking ⠋';
  const right = '12.0k / 128.0k (9%)';
  const zone = thinkingHitZone({ left, right, width: 80, leftPad: 1 });

  // The painted row is the authority. It carries no padding of its own — the box
  // adds `leftPad` on top — so the zone, measured from the box edge, starts one cell
  // in, and the label spans exactly the cells the composer painted.
  const row = composeStatusRow(sanitize(left), sanitize(right), 80);
  const cells = zone.end - zone.start;
  assert.equal(row.slice(0, cells), left, 'the zone covers exactly the painted label');
  assert.equal(zone.start, 1, 'the box pads one cell on the left');
});

test('a truncated label has a truncated zone, and a hit past it is a miss', () => {
  const left = 'Thinking ⠋';
  const right = '128.0k (from API)';
  const width = 20;
  const zone = thinkingHitZone({ left, right, width, leftPad: 1 });
  const row = composeStatusRow(sanitize(left), sanitize(right), width);

  assert.ok(zone.end - zone.start < left.length, 'the label was cut by the composer');
  assert.equal(row.slice(zone.start, zone.end), row.slice(1, 1 + (zone.end - zone.start)));
  // One cell past the truncated label is the padding the composer added, not the label.
  assert.equal(clickedThinkingLabel({ x: zone.end }, zone), false);
  assert.equal(clickedThinkingLabel({ x: zone.start }, zone), true);
});

test('a hit is tested against the cells the label occupies', () => {
  const zone = { start: 1, end: 11 };
  assert.equal(clickedThinkingLabel({ x: 0 }, zone), false, 'the padding is not the label');
  assert.equal(clickedThinkingLabel({ x: 1 }, zone), true);
  assert.equal(clickedThinkingLabel({ x: 10 }, zone), true);
  assert.equal(clickedThinkingLabel({ x: 11 }, zone), false, 'the interval is half-open');
  assert.equal(clickedThinkingLabel({ x: undefined }, zone), false, 'a broken report is not a hit');
  assert.equal(clickedThinkingLabel({ x: 5 }, null), false, 'no zone, no target');
});

test('no label is painted without a meter and no width, and the zone follows', () => {
  assert.deepEqual(thinkingHitZone({ left: 'Thinking ⠋', right: '', width: 0, leftPad: 0 }), { start: 0, end: 10 });
  assert.equal(thinkingHitZone({ left: '', right: '1.0k', width: 80 }), null);
});

/** A stand-in for the surface's modal opener, so the binder is testable alone. */
function fakeBar() {
  const listeners = new Map();
  return {
    on(event, fn) {
      listeners.set(event, fn);
      return this;
    },
    removeListener(event, fn) {
      if (listeners.get(event) === fn) listeners.delete(event);
      return this;
    },
    emit(event, data) {
      return listeners.has(event) ? listeners.get(event)(data) : false;
    },
    get bound() {
      return listeners.size;
    },
  };
}

test('between turns the label is not a target at all', () => {
  const statusRow = createStatusRow({ width: () => 80 });
  const opened = [];
  const bar = fakeBar();
  bindThinkingClick({
    statusBar: bar,
    statusRow,
    width: () => 80,
    contentView: (view) => { opened.push(view); return Promise.resolve(null); },
    buildView: () => ({ title: 'Thinking', documents: [{ name: 'thinking', text: 'x' }], reload: () => [] }),
  });

  // No spinner: the left slot is the logical status text, and clicking it does nothing.
  assert.equal(statusRow.isSpinning(), false);
  bar.emit('click', { x: 2 });
  assert.equal(opened.length, 0);
});

test('a click on the spinning label opens the viewer, and one off it does not', async () => {
  const statusRow = createStatusRow({ width: () => 80 });
  statusRow.setMeter('12.0k / 128.0k (9%)');
  statusRow.startSpinner();
  const opened = [];
  const bar = fakeBar();
  bindThinkingClick({
    statusBar: bar,
    statusRow,
    width: () => 80,
    contentView: (view) => { opened.push(view); return Promise.resolve({ closed: 'escape' }); },
    buildView: () => ({ title: 'Thinking', documents: [{ name: 'thinking', text: 'x' }], reload: () => [] }),
  });

  // Far right is the meter, which is not the label.
  bar.emit('click', { x: 70 });
  assert.equal(opened.length, 0);

  bar.emit('click', { x: 3 });
  await flush();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].title, 'Thinking');
  statusRow.dispose();
});

test('with no capture yet, the click is consumed and says there is nothing yet', async () => {
  const statusRow = createStatusRow({ width: () => 80 });
  statusRow.startSpinner();
  const opened = [];
  const noticed = [];
  const bar = fakeBar();
  bindThinkingClick({
    statusBar: bar,
    statusRow,
    width: () => 80,
    contentView: (view) => { opened.push(view); return Promise.resolve(null); },
    buildView: () => null,
    notify: (error) => noticed.push(error),
  });

  bar.emit('click', { x: 3 });
  await flush();
  assert.equal(opened.length, 0, 'nothing to show is not an empty box');
  // A consumed click that opened nothing is indistinguishable from a dead binding, which
  // is exactly how this feature looked broken in use. It reports instead of going quiet.
  assert.equal(noticed.length, 1, 'the click says why nothing opened');
  assert.match(noticed[0].message, /no reasoning captured yet/);
  statusRow.dispose();
});

test('a failing open is reported through notify, never thrown into the click', async () => {
  const statusRow = createStatusRow({ width: () => 80 });
  statusRow.startSpinner();
  const reported = [];
  const bar = fakeBar();
  bindThinkingClick({
    statusBar: bar,
    statusRow,
    width: () => 80,
    contentView: () => Promise.reject(new Error('screen gone')),
    buildView: () => ({ title: 'Thinking', documents: [{ name: 'thinking', text: 'x' }], reload: () => [] }),
    notify: (error) => reported.push(error.message),
  });

  assert.doesNotThrow(() => bar.emit('click', { x: 3 }));
  await flush();
  assert.deepEqual(reported, ['screen gone']);
  statusRow.dispose();
});

test('the binding is removed at teardown, so a click after close reaches nothing', () => {
  const statusRow = createStatusRow({ width: () => 80 });
  statusRow.startSpinner();
  const bar = fakeBar();
  const binding = bindThinkingClick({
    statusBar: bar,
    statusRow,
    width: () => 80,
    contentView: () => Promise.resolve(null),
  });
  assert.equal(bar.bound, 1);
  binding.dispose();
  assert.equal(bar.bound, 0);
  statusRow.dispose();
});

test('the Thinking label on the real screen opens the capture in the viewer', async () => {
    const file = writeCapture('the reader is thinking about the capture\n');

    await withTui(async (tui) => {
      // The viewer the TUI really wires is the surface's own `contentView`; spying on it
    // proves the click travelled from the painted row to the shipped wiring, not just
    // to a stand-in built by this test.
    const opened = [];
    const original = tui.contentView;
    tui.contentView = (view) => { opened.push(view); return Promise.resolve({ closed: 'escape' }); };
    try {
      // The status row the TUI really paints into, told to spin as a request would.
      // The surface exposes the row through these two calls, not as `statusRow`.
      tui.setTokens('12.0k / 128.0k (9%)');
      tui.startSpinner();
      await flush();

      // A click on the label, delivered the way blessed delivers one. The box spans the
      // screen (left 0), so its cells and the screen's columns are the same coordinate.
      const origin = Number(tui.statusBar.lpos?.xi) || 0;
      tui.statusBar.emit('click', { x: origin + 2, y: tui.statusBar.lpos?.yi ?? 0 });
      await flush();

      assert.equal(opened.length, 1, 'the click opened the surface viewer');
      assert.equal(opened[0].title, 'Thinking');
      assert.equal(opened[0].documents[0].name, 'thinking');
      assert.match(opened[0].documents[0].text, /thinking about the capture/);
      assert.ok(opened[0].documents[0].path.endsWith('thinking.md'));
      } finally {
        tui.contentView = original;
        tui.stopSpinner();
      }
  }, { columns: 100, rows: 30 });

  assert.ok(file.endsWith('thinking.md'));
});

test('a non-streaming reply keeps its reasoning, so the view has a capture to open', () => {
  // The regression this case exists for: every production call site passes
  // `isStreaming = false`, so the branch that appended to THINKING_FILE never ran and
  // the file the view reads was never written. The wiring was correct and the feature
  // still opened nothing, because the producer half lives in the normaliser.
  const ollama = normalizeResponse({
    message: { content: 'the answer', thinking: 'the reasoning it thought', tool_calls: [] },
  });
  assert.equal(ollama.message.thinking, 'the reasoning it thought',
    'the reasoning survives normalisation');
  assert.equal(ollama.message.content, 'the answer', 'the answer itself is unchanged');

  // A reply with no reasoning channel is shaped exactly as it was before the field.
  const plain = normalizeResponse({ message: { content: 'hi' } });
  assert.equal('thinking' in plain.message, false, 'no empty field is invented');
});