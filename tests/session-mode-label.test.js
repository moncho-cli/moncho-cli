import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionMode, MODE_COLORS, WORK_ON_LABEL } from '../app/session-mode.js';
import {
  MODE_LABEL_SEPARATOR,
  createModeRow,
  defaultModeState,
  formatModeRow,
  formatModeTag,
} from '../app/session-mode-label.js';
import { createTui } from '../app/tui.js';
import { fakeTty } from './support/tui-harness.js';

/**
 * The mode label at the leftmost cell of the model row (task.md item 6).
 *
 * The pure composition (the order, the colour, the escaping) is checked without
 * a terminal, and the wiring is checked against a fabricated pty, so both the
 * string a test can read and the row a user sees are proved.
 */

/** The visible text of a row, with the blessed colour escapes stripped. */
const strip = (content) => String(content ?? '').replace(/\x1b\[[\d;]*m/g, '');

async function withModeTui(mode, fn) {
  const input = fakeTty();
  const output = fakeTty();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk.toString()));
  const tui = createTui({ input, output, modelLabel: 'probe · model', mode });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    return await fn(tui, () => chunks.join(''));
  } finally {
    if (tui) tui.close();
    input.destroy();
    output.destroy();
  }
}

test('formatModeRow() paints the mode label at the leftmost cell and the model after it', () => {
  const state = createSessionMode().describe();
  const row = formatModeRow(state, 'openrouter · test/model');

  assert.equal(
    row,
    `{green-fg}Chat{/green-fg}${MODE_LABEL_SEPARATOR}openrouter · test/model`,
  );
  assert.equal(row.indexOf('Chat'), row.indexOf('{green-fg}') + '{green-fg}'.length);

  // The identity is optional, and a missing one never leaves a trailing space.
  assert.equal(formatModeRow(state, ''), '{green-fg}Chat{/green-fg}');
  assert.equal(formatModeRow(state), '{green-fg}Chat{/green-fg}');

  // A model name is environment-driven text: the screen must not interpret it.
  assert.equal(formatModeRow(state, 'a{b}'), '{green-fg}Chat{/green-fg} a{open}b{close}');
  assert.equal(formatModeRow(state, 'a\x1b[31mb'), '{green-fg}Chat{/green-fg} ab');

  // The lock is visible in the row, not only in the commands.
  const locked = createSessionMode({ work: true }).describe();
  assert.equal(formatModeRow(locked, 'm'), `{bright-red-fg}${WORK_ON_LABEL}{/bright-red-fg} m`);
});

test('formatModeTag() uses one bright colour per state and escapes the label', () => {
  const mode = createSessionMode();
  const colours = [mode.describe().color];

  assert.equal(formatModeTag(mode.describe()), '{green-fg}Chat{/green-fg}');

  mode.setMode('design');
  colours.push(mode.describe().color);
  assert.equal(formatModeTag(mode.describe()), '{bright-cyan-fg}Design{/bright-cyan-fg}');

  mode.setMode('work');
  colours.push(mode.describe().color);
  assert.equal(formatModeTag(mode.describe()), '{yellow-fg}Work{/yellow-fg}');

  mode.setWork(true);
  colours.push(mode.describe().color);
  assert.equal(formatModeTag(mode.describe()), '{bright-red-fg}Work:on{/bright-red-fg}');

  // One colour per state, and the locked work is not confused with a plain Work.
  assert.deepEqual(new Set(colours).size, 4);
  assert.deepEqual(colours, [
    MODE_COLORS.chat, MODE_COLORS.design, MODE_COLORS.work, MODE_COLORS['work:on'],
  ]);

  // Junk in a hand-made state cannot smuggle a tag or break the row.
  assert.equal(formatModeTag({ label: 'a{b}', color: 'green' }), '{green-fg}a{open}b{close}{/green-fg}');
  assert.equal(formatModeTag({ label: 'x', color: '}; evil {red' }), '{green-fg}x{/green-fg}');
  assert.equal(formatModeTag(), '{green-fg}Chat{/green-fg}');
  assert.equal(formatModeTag(null), '{green-fg}Chat{/green-fg}');
});

test('createModeRow() repaints on an accepted mode change and never on a refused one', () => {
  const mode = createSessionMode();
  const painted = [];
  const row = createModeRow({ mode, modelLabel: 'm', paint: (line) => painted.push(line) });

  assert.equal(painted.length, 0, 'constructing the row paints nothing: the caller decides');
  assert.equal(row.render(), '{green-fg}Chat{/green-fg} m');
  assert.deepEqual(painted, ['{green-fg}Chat{/green-fg} m']);

  // An accepted change repaints, once, with the new state.
  assert.equal(mode.cycle().changed, true);
  assert.deepEqual(painted.at(-1), '{bright-cyan-fg}Design{/bright-cyan-fg} m');
  assert.equal(row.state.label, 'Design');

  // The lock refuses the move, so the row keeps the state it was showing.
  const before = painted.length;
  assert.equal(mode.setWork(true).changed, true);
  assert.equal(painted.at(-1), '{bright-red-fg}Work:on{/bright-red-fg} m');
  const afterLock = painted.length;

  assert.equal(mode.cycle().changed, false);
  assert.equal(mode.setMode('chat').changed, false);
  assert.equal(mode.setWork(true).changed, false);
  assert.equal(painted.length, afterLock, 'a refused or idempotent move must not repaint');
  assert.ok(afterLock > before);

  row.close();
  assert.equal(mode.setWork(false).changed, true);
  assert.equal(painted.length, afterLock, 'a closed row is no longer subscribed');
});

test('createModeRow() paints the chat default without a mode, and setState() moves it', () => {
  const painted = [];
  const row = createModeRow({ paint: (line) => painted.push(line) });

  assert.deepEqual(row.state, defaultModeState());
  assert.equal(row.render(), '{green-fg}Chat{/green-fg}');
  assert.equal(formatModeRow(defaultModeState(), 'm'), '{green-fg}Chat{/green-fg} m');

  assert.equal(row.setState({ label: 'Work', color: 'yellow' }), '{yellow-fg}Work{/yellow-fg}');
  assert.equal(row.state.label, 'Work');
  // A caller that clears the state gets the safe, read-only default back.
  assert.equal(row.setState(null), '{green-fg}Chat{/green-fg}');
  assert.deepEqual(painted.length, 3);
});

test('the TUI paints the session mode at the leftmost cell of the model row', async () => {
  const mode = createSessionMode();

  await withModeTui(mode, (tui) => {
    const row = strip(tui.modelBar.getContent());
    assert.equal(row, 'Chat probe · model', 'the label starts the row');
    assert.deepEqual(tui.modeState, mode.describe());
    // The very first cell is the label, not the identity.
    assert.equal(row.startsWith('Chat'), true);

    const chatPrefix = /^\x1b\[[\d;]*m/.exec(tui.modelBar.getContent())?.[0];
    assert.ok(chatPrefix, 'the label really is coloured');

    // Tab moves the mode and the row follows, without a repaint of its own.
    mode.cycle();
    assert.equal(strip(tui.modelBar.getContent()), 'Design probe · model');
    mode.cycle();
    assert.equal(strip(tui.modelBar.getContent()), 'Work probe · model');
    mode.setWork(true);
    assert.equal(strip(tui.modelBar.getContent()), 'Work:on probe · model');

    const lockedPrefix = /^\x1b\[[\d;]*m/.exec(tui.modelBar.getContent())?.[0];
    assert.notEqual(lockedPrefix, chatPrefix, 'the locked state has its own colour');

    // Refused while locked: the row keeps showing the state the user is in.
    assert.equal(mode.cycle().changed, false);
    assert.equal(strip(tui.modelBar.getContent()), 'Work:on probe · model');
  });
});

test('the TUI without a session mode still shows the read-only chat default', async () => {
  await withModeTui(null, (tui) => {
    assert.equal(strip(tui.modelBar.getContent()), 'Chat probe · model');
    assert.equal(tui.modeState.key, 'chat');
  });
});
