import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  COLLAPSE_NOTICE_PREFIX,
  formatCollapseNotice,
  createCollapseNotifier,
} from '../app/collapse-notice.js';
import { ContextWindow } from '../app/context-window.js';
import { requestItemCollapse, runItemCollapse } from '../app/item-collapse-runner.js';
import {
  registerSession, clearSession, registerContextWindow, clearContextWindow,
  registerCollapseNotifier, notifyCollapse, clearCollapseNotifier,
} from '../utils/host.js';
import { classifyLine } from '../app/theme.js';

/**
 * Proof for the collapse announcement (docs/interface/collapse-notice).
 *
 * The gap this closes: a collapse shrank the window and kept the raw chunks in a
 * chunkpaction capture, and only the *model* was told — the report rides back in
 * `update_task`'s JSON reply, which never reaches the transcript. The user, who watches
 * the conversation, saw the window shrink with no explanation.
 */

const SESSION_ID = 'collapse-notice-test';

// The collapse writes a real chunkpaction.json into the session folder, so the suite runs
// from a temp root: nothing lands in the repo, and the capture counter starts fresh.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-collapse-notice-'));
const ORIGINAL_CWD = process.cwd();
process.chdir(ROOT);

test.after(() => {
  process.chdir(ORIGINAL_CWD);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/**
 * Run `body` with the collapse switch on, restoring whatever was there.
 *
 * The collapse is opt-in (`config/constants.js#chunkpactionEnabled`), so every case that
 * expects a real rewrite has to turn it on; the off case is the unset default.
 */
function withSwitchOn(body) {
  const previous = process.env.CHUNKPACTION_ENABLED;
  process.env.CHUNKPACTION_ENABLED = '1';
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.CHUNKPACTION_ENABLED;
    else process.env.CHUNKPACTION_ENABLED = previous;
  }
}

test.afterEach(() => {
  clearSession();
  clearContextWindow();
  clearCollapseNotifier();
});
/** A window holding one solved item's section plus an unattributed tail. */
function windowWithOneSection() {
  const window = new ContextWindow({ maxTokens: 1_000_000, monchoVersion: '0.25.1' });
  window.setCurrentItem('wire the reader');
  window.addMany([
    { role: 'user', content: `${'x'.repeat(400)} do it` },
    { role: 'assistant', content: 'reasoning', tool_calls: [{ id: 'c1', function: { name: 'read_file' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ]);
  window.setCurrentItem(null);
  window.add({ role: 'user', content: 'the next thing' });
  return window;
}

// ---------------------------------------------------------------------------
// The wording
// ---------------------------------------------------------------------------

test('a collapse prints one line naming the item, the size and the capture', () => {
  const lines = formatCollapseNotice({
    collapsed: [{ item: 'wire the reader', chunks: 3, capture: 2 }],
    chunks: 2,
  });

  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith(COLLAPSE_NOTICE_PREFIX), 'the context prefix, so the theme colours it');
  assert.ok(lines[0].includes('"wire the reader"'), 'the item, quoted so a row cannot break');
  assert.ok(lines[0].includes('3 chunks'), 'what was replaced');
  assert.ok(lines[0].includes('read_chunkpaction({ capture: 2 })'), 'where the raw chunks went');
});

test('the line is singular for one chunk, plural for several', () => {
  const one = formatCollapseNotice({ collapsed: [{ item: 'a', chunks: 1, capture: 1 }] });
  const many = formatCollapseNotice({ collapsed: [{ item: 'b', chunks: 4, capture: 2 }] });
  assert.ok(one[0].includes('1 chunk)'));
  assert.ok(many[0].includes('4 chunks)'));
});

test('a collapse with no capture names no id rather than inventing one', () => {
  const lines = formatCollapseNotice({ collapsed: [{ item: 'a', chunks: 2, capture: null }] });
  assert.equal(lines.length, 1, 'the collapse is still announced');
  assert.ok(!lines[0].includes('read_chunkpaction'), 'but there is no pointer to print');
});

test('a multi-line item is flattened so the row cannot break', () => {
  const lines = formatCollapseNotice({ collapsed: [{ item: 'fix\n  the   parser', chunks: 2, capture: 1 }] });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('\n'), 'the whole line stays on one row');
  assert.ok(lines[0].includes('fix the parser'));
});

test('several collapsed items print one line each, in order', () => {
  const lines = formatCollapseNotice({
    collapsed: [
      { item: 'first', chunks: 2, capture: 1 },
      { item: 'second', chunks: 3, capture: 2 },
    ],
  });
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('first'));
  assert.ok(lines[1].includes('second'));
});

test('nothing collapsed prints nothing, so a no-op shows no row', () => {
  assert.deepEqual(formatCollapseNotice({ collapsed: [] }), []);
  assert.deepEqual(formatCollapseNotice({}), []);
  assert.deepEqual(formatCollapseNotice(), []);
  assert.deepEqual(formatCollapseNotice(null), []);
});

test('the line reads as a context event, so the theme colours it with no new rule', () => {
  const [line] = formatCollapseNotice({ collapsed: [{ item: 'a', chunks: 2, capture: 1 }] });
  assert.equal(classifyLine(line), 'context', 'the same family the compaction lines belong to');
});

// ---------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------

test('a real collapse announces itself once, with the id the summary names', () => {
  registerSession({ id: SESSION_ID });
  registerContextWindow(windowWithOneSection());
  const shown = [];
  registerCollapseNotifier(createCollapseNotifier({ log: (line) => shown.push(line) }));

  // `update_task` only asks for the collapse and the tool batch drains it
  // (app/item-collapse-runner.js); outside a batch the pair is that same rewrite.
  const report = withSwitchOn(() => {
    requestItemCollapse(['wire the reader']);
    return runItemCollapse();
  });

  assert.equal(report.collapsed.length, 1);
  assert.equal(shown.length, 1, 'exactly one row for one collapse');
  // The id is read from the report, not hardcoded: the capture file persists in the
  // session folder, so its counter keeps climbing across runs — and the invariant is
  // that the line names *the* id, whichever one it is.
  const capture = report.collapsed[0].capture;
  assert.equal(typeof capture, 'number');
  assert.ok(shown[0].includes(`read_chunkpaction({ capture: ${capture} })`), 'the id the summary names');
  assert.ok(shown[0].includes('"wire the reader"'));
});

test('a collapse the guards refuse shows nothing', () => {
  registerSession({ id: SESSION_ID });
  const window = windowWithOneSection();
  registerContextWindow(window);
  const shown = [];
  registerCollapseNotifier(createCollapseNotifier({ log: (line) => shown.push(line) }));

  // An item that is not completed is never collapsed, so there is nothing to announce.
  const report = withSwitchOn(() => {
    requestItemCollapse([]);
    return runItemCollapse();
  });

  assert.deepEqual(report.collapsed, []);
  assert.deepEqual(shown, [], 'no rewrite, no row');
});

test('with no sink registered the collapse is silent, not a throw', () => {
  registerSession({ id: SESSION_ID });
  registerContextWindow(windowWithOneSection());
  clearCollapseNotifier();

  const report = withSwitchOn(() => {
    requestItemCollapse(['wire the reader']);
    return runItemCollapse();
  });
  assert.equal(report.collapsed.length, 1, 'the collapse still happened');
  assert.deepEqual(notifyCollapse(report), [], 'and reporting it is a no-op');
});

test('the notifier counts what it announced', () => {
  const notifier = createCollapseNotifier({ log: () => {} });
  assert.equal(notifier.announced, 0);
  notifier.notify({ collapsed: [{ item: 'a', chunks: 2, capture: 1 }] });
  assert.equal(notifier.announced, 1);
  // A no-op collapse is not an announcement.
  notifier.notify({ collapsed: [] });
  assert.equal(notifier.announced, 1);
});
