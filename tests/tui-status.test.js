import test from 'node:test';
import assert from 'node:assert/strict';

import { composeStatusRow, SPINNER_INTERVAL_MS } from '../app/tui.js';
import { createStatusRow } from '../app/status-row.js';
import { withTui, statusRow } from './support/tui-harness.js';

test('composeStatusRow() right-aligns the meter and never drops it', () => {
  const meter = '2.4k / 8.0k tokens (30%)';
  const row = composeStatusRow('Ready', meter, 40);
  assert.equal(row.length, 40);
  assert.ok(row.startsWith('Ready'));
  assert.ok(row.endsWith(meter));
  assert.equal(row, `Ready${' '.repeat(40 - 'Ready'.length - meter.length)}${meter}`);

  // no width yet (the screen is not laid out): both parts are kept, joined
  assert.equal(composeStatusRow('Ready', meter, 0), `Ready ${meter}`);
  // a narrow row truncates the status text, never the meter
  const narrow = composeStatusRow('Thinking about it', meter, 30);
  assert.equal(narrow.length, 30);
  assert.equal(narrow, `Think ${meter}`);
  assert.ok(narrow.endsWith(meter));
  // no meter => the status text is untouched
  assert.equal(composeStatusRow('Ready', '', 40), 'Ready');
  // no status => the meter is still right-aligned
  assert.equal(composeStatusRow('', meter, 40), `${' '.repeat(40 - meter.length)}${meter}`);
});

test('setStatus() updates the status bar', async () => {
  await withTui((tui) => {
    tui.setStatus('1.2k / 8.0k tokens (15%)');
    assert.equal(tui.statusBar.getContent(), '1.2k / 8.0k tokens (15%)');
  });
});

test('setTokens() renders the context-window usage meter, right-aligned', async () => {
  await withTui((tui) => {
    tui.setTokens('2.4k / 8.0k tokens (30%)');
    const plain = statusRow(tui);
    // the meter is pinned to the right edge of the 80-column row (minus padding)
    assert.equal(plain.length, 78);
    assert.ok(plain.endsWith('2.4k / 8.0k tokens (30%)'), `got ${JSON.stringify(plain)}`);
    assert.ok(plain.startsWith('Ready'), 'the status text stays on the left');
  });
});

test('setTokens() accepts the stats.usage string from onContextChange', async () => {
  await withTui((tui) => {
    const stats = { usage: '3.4k / 8.0k tokens (43%)' };
    tui.setTokens(stats.usage);
    const plain = statusRow(tui);
    assert.ok(plain.endsWith('3.4k / 8.0k tokens (43%)'));
    // the logical status text keeps the left slot of the very same row
    assert.ok(plain.startsWith('Ready '), `expected Ready on the left, got ${JSON.stringify(plain)}`);
  });
});

test('startSpinner() paints a frame and reports the in-flight state', async () => {
  await withTui((tui) => {
    tui.setStatus('Ready');
    tui.setTokens('1.2k / 8.0k tokens (15%)');
    tui.startSpinner();
    assert.equal(tui.isSpinning(), true);
    const plain = statusRow(tui);
    assert.ok(plain.startsWith('Thinking ⠋'), `expected the spinner on the left, got ${JSON.stringify(plain)}`);
    // ... and the meter stays visible, right-aligned, while the request runs
    assert.ok(plain.endsWith('1.2k / 8.0k tokens (15%)'));
    assert.equal(plain.length, 78);
  });
});

test('the context meter stays visible while the spinner is running', async () => {
  await withTui(async (tui, { output }) => {
    tui.setTokens('2.4k / 8.0k tokens (30%)');
    tui.startSpinner();
    assert.ok(statusRow(tui).endsWith('2.4k / 8.0k tokens (30%)'));

    // a real in-flight update (main.js calls setTokens from onContextChange)
    // repaints immediately instead of being swallowed by the spinner
    tui.setTokens('3.4k / 8.0k tokens (43%)');
    assert.ok(statusRow(tui).endsWith('3.4k / 8.0k tokens (43%)'));
    assert.ok(statusRow(tui).startsWith('Thinking '));

    // the meter is re-pinned to the (possibly narrower) right edge on resize
    output.columns = 60;
    output.emit('resize');
    assert.ok(statusRow(tui).endsWith('3.4k / 8.0k tokens (43%)'));
    assert.equal(statusRow(tui).length, 58);

    tui.stopSpinner();
    assert.ok(statusRow(tui).endsWith('3.4k / 8.0k tokens (43%)'));
  });
});

test('stopSpinner() stops the timer and restores the pre-spinner status', async () => {
  await withTui((tui) => {
    tui.setStatus('Ready');
    tui.setTokens('1.2k / 8.0k tokens (15%)');
    tui.startSpinner();
    tui.stopSpinner();
    assert.equal(tui.isSpinning(), false);
    const plain = statusRow(tui);
    assert.ok(plain.startsWith('Ready '));
    assert.ok(plain.endsWith('1.2k / 8.0k tokens (15%)'));
    assert.doesNotMatch(plain, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });
});

test('an aborted request leaks no spinner frame after stopSpinner()', async () => {
  await withTui(async (tui) => {
    tui.setStatus('2.4k / 8.0k tokens (30%)');
    tui.startSpinner();
    try {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    } catch {
      // the abort is swallowed, exactly as in main.js
    } finally {
      tui.stopSpinner();
    }
    await new Promise((resolve) => setTimeout(resolve, 3 * SPINNER_INTERVAL_MS));
    assert.equal(tui.isSpinning(), false);
    const plain = statusRow(tui);
    assert.equal(plain, '2.4k / 8.0k tokens (30%)');
    assert.doesNotMatch(plain, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });
});

test('createStatusRow() keeps the left slot derived from the in-flight state', () => {
  // Pure bookkeeping, driven without a terminal: the same rules the widget obeys.
  const painted = [];
  const row = createStatusRow({ paint: (line) => painted.push(line), width: () => 40 });

  row.setStatus('Ready');
  row.setMeter('1k / 8k tokens (12%)');
  assert.ok(painted.at(-1).endsWith('1k / 8k tokens (12%)'));
  assert.ok(painted.at(-1).startsWith('Ready'));

  assert.equal(row.isSpinning(), false);
  assert.equal(row.startSpinner(), true);
  assert.equal(row.isSpinning(), true);
  assert.equal(row.startSpinner(), false, 'a second start is a no-op');
  assert.ok(painted.at(-1).startsWith('Thinking '));
  assert.ok(painted.at(-1).endsWith('1k / 8k tokens (12%)'), 'the meter survives the spinner');

  assert.equal(row.stopSpinner(), true);
  assert.equal(row.isSpinning(), false);
  assert.ok(painted.at(-1).startsWith('Ready'), 'the status text comes back by itself');
  assert.doesNotMatch(painted.at(-1), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);

  // after dispose nothing is painted any more
  row.dispose();
  const count = painted.length;
  row.setStatus('ignored');
  assert.equal(painted.length, count);
});
