import test from 'node:test';
import assert from 'node:assert/strict';

import { withScreen, type, tick } from './support/slash-screen.js';

/**
 * The slash-command popup **on a real screen** (docs/interface/slash-autocomplete): what
 * the reader actually sees when they type a slash, and what the keys do to it.
 *
 * Split from `tests/slash-autocomplete.test.js` on purpose. That suite proves the rules
 * as values — the query, the ranking, the menu state — with no terminal in sight. These
 * cases exist because two bugs were invisible to it and only a real blessed screen showed
 * them: a cursor move that repainted the screen but not the bar, and a `{inverse}` marker
 * painted as literal text because the box was built with `tags: false`.
 */

const COMMANDS = [
  { name: 'compact', description: 'compact the context window' },
  { name: 'help', description: 'list the available commands' },
  { name: 'sessions', description: 'list stored conversations and continue one', aliases: ['resume'] },
  { name: 'usage', description: 'token usage per model in this session' },
  { name: 'work', description: 'turn the execution lock on or off' },
];

const screen = (fn) => withScreen(fn, COMMANDS);

test('the selected row is a blue band filled to the bar, never a literal tag', async () => {
  // The bug this exists for: the box was built with `tags: false`, so `{inverse}` was
  // *painted* — the reader saw the marker in the middle of the row.
  await screen(async (tui) => {
    await type(tui, '/');
    const content = tui.slashBar.widget.getContent();
    assert.ok(!content.includes('{inverse}'), `the marker must be a tag, not text: ${content}`);
    assert.ok(!content.includes('{/inverse}'), 'the closing marker must be a tag, not text');

    // The selected row carries a background, filled out to the bar's interior width, so
    // the band reaches the padding instead of stopping short of it.
    const lines = content.split('\n');
    const selected = lines.find((line) => line.includes('/compact'));
    assert.ok(selected, 'the selected row must be painted');
    assert.ok(/\x1b\[4\d?m/.test(selected), `the row needs a background: ${JSON.stringify(selected)}`);

    // Measured in cells against the very width the rows were fitted to: a banded row is
    // exactly the interior width once its escapes are gone, so the fill is complete.
    const width = tui.slashBar.columns;
    const visible = selected.replace(/\x1b\[[0-9;]*m/g, '');
    assert.equal(visible.length, width, `the band must fill ${width} cells, got ${visible.length}`);

    // A row that is not selected carries no background at all.
    const other = lines.find((line) => line.includes('/sessions'));
    assert.ok(!/\x1b\[4\d?m/.test(other), 'only the selected row is banded');
  });
});

test('the slash popup opens, filters, moves, completes and runs commands in the real TUI', async () => {
  await screen(async (tui) => {
    // Nothing on screen until a slash is typed.
    assert.equal(tui.slashOpen, false);

    await type(tui, '/');
    assert.equal(tui.slashOpen, true);
    assert.equal(tui.slashRows.length, COMMANDS.length);
    assert.equal(tui.slashRows[0].command.name, 'compact');

    // The list filters as the query grows, and the best row carries the cursor.
    await type(tui, 'se');
    assert.deepEqual(tui.slashRows.map((row) => row.command.name), ['sessions', 'usage']);
    assert.equal(tui.slashRows[0].selected, true);

    // The arrows move the highlight and hand it back — the bug that made a move
    // invisible was a repaint the bar never got.
    tui.inputBox._listener('', { name: 'down' });
    await tick();
    assert.equal(tui.slashRows.find((row) => row.selected).command.name, 'usage');
    tui.inputBox._listener('', { name: 'up' });
    await tick();
    assert.equal(tui.slashRows.find((row) => row.selected).command.name, 'sessions');

    // Tab is claimed before blessed dispatches it, completes the name and closes the menu.
    tui.screen.program.emit('keypress', '\x09', { name: 'tab', full: 'tab' });
    await tick();
    assert.equal(tui.promptValue, '/sessions ');
    assert.equal(tui.slashOpen, false);

    // A space ended the name, so typing more does not reopen the popup.
    await type(tui, 'now');
    assert.equal(tui.slashOpen, false);

    // Enter on a highlighted row submits that command, exactly once, and empties the box.
    tui.promptKeys.reset();
    await tick();
    await type(tui, '/us');
    assert.equal(tui.slashOpen, true);
    const submitted = [];
    const original = tui.promptInput.submit;
    tui.promptInput.submit = (value) => { submitted.push(value); return original(value); };
    try {
      tui.inputBox._listener('', { name: 'enter' });
      await tick();
    } finally {
      tui.promptInput.submit = original;
    }
    assert.deepEqual(submitted, ['/usage']);
    assert.equal(tui.promptValue, '');
    assert.equal(tui.slashOpen, false);
  });
});