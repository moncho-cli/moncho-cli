import test from 'node:test';
import assert from 'node:assert/strict';

import {
  slashQuery, rankCommands, slashRows, formatSlashRow, SLASH_MAX_ROWS,
} from '../app/slash-complete.js';
import { createSlashMenu, slashCompleteText, slashAcceptText } from '../app/slash-menu.js';
import { claimMenuKey, completeMenuKey } from '../app/prompt-menu-keys.js';
import { createSlashBar } from '../app/slash-bar.js';

/**
 * The slash-command popup (docs/interface/slash-autocomplete): a leading `/` opens a
 * filtered list of the registry's own commands, filtered by the name, and the two accept
 * paths put the highlighted row in the box or run it.
 *
 * The cases are ordered the way a keystroke travels — the query, the ranking, the rows,
 * the menu, the keys, the bar — and they prove the rules as **values**, with no terminal
 * in sight. The screen itself has its own suite (`tests/slash-popup-screen.test.js`),
 * because two of its bugs were invisible from here: a cursor move that repainted the
 * screen but not the bar, and a marker painted as literal text.
 */

const COMMANDS = [
  { name: 'compact', description: 'compact the context window' },
  { name: 'help', description: 'list the available commands' },
  { name: 'sessions', description: 'list stored conversations and continue one', aliases: ['resume'] },
  { name: 'usage', description: 'token usage per model in this session' },
  { name: 'work', description: 'turn the execution lock on or off' },
];

const names = (list) => list.map((command) => command.name);

test('slashQuery() recognises a half-typed command name and nothing else', () => {
  // A bare slash lists everything: the query is empty, not "no query".
  assert.deepEqual(slashQuery('/'), { query: '' });
  assert.deepEqual(slashQuery('/co'), { query: 'co' });
  assert.deepEqual(slashQuery('/work-2_x'), { query: 'work-2_x' });

  // A space ends the command name, so the box is typing arguments.
  assert.equal(slashQuery('/sessions now'), null);
  assert.equal(slashQuery('/work on'), null);
  // A prompt that merely mentions a command is a prompt.
  assert.equal(slashQuery('ask /help'), null);
  assert.equal(slashQuery('hello'), null);
  // The parser's own character class (`[A-Za-z][\w-]*`), so no name is offered that
  // `parseCommand()` would refuse to read.
  assert.equal(slashQuery('/1'), null);
  assert.equal(slashQuery('/ '), null);
  assert.equal(slashQuery(''), null);
});

test('rankCommands() answers by name: the prefix first, then a subsequence', () => {
  // A bare query keeps the alphabetical order the registry already holds.
  assert.deepEqual(names(rankCommands(COMMANDS, '')), ['compact', 'help', 'sessions', 'usage', 'work']);

  // The prefix wins over everything else: `/co` is compact, not the two descriptions
  // that happen to contain "co".
  assert.deepEqual(names(rankCommands(COMMANDS, 'co')), ['compact']);
  assert.deepEqual(names(rankCommands(COMMANDS, 's')), ['sessions', 'usage']);

  // A subsequence finds a command whose letters were typed out of order.
  assert.deepEqual(names(rankCommands(COMMANDS, 'ses')), ['sessions']);
  assert.deepEqual(names(rankCommands(COMMANDS, 'wrk')), ['work']);
  // An alias is an invocation of its command, so it names it too.
  assert.deepEqual(names(rankCommands(COMMANDS, 'resume')), ['sessions']);

  // The description is deliberately not searched: a word the commands do not answer
  // leaves the popup closed instead of offering whoever mentions it.
  assert.deepEqual(names(rankCommands(COMMANDS, 'list')), []);
  assert.deepEqual(names(rankCommands(COMMANDS, 'zzz')), []);

  // A missing or junk list is an empty answer, never a throw.
  assert.deepEqual(rankCommands(null, 'co'), []);
  assert.deepEqual(rankCommands([{ description: 'no name' }, null], 'co'), []);
});

test('formatSlashRow() and slashRows() fit every row to the bar and keep the cursor in view', () => {
  const row = formatSlashRow(COMMANDS[2], { selected: true, columns: 60 });
  assert.ok(row.startsWith('> /sessions'), row);
  assert.ok(row.length <= 60, `row must fit the bar: ${row}`);
  // A width it cannot fit still keeps the name, which is what the row exists to show:
  // the description is dropped long before the command is.
  assert.equal(formatSlashRow(COMMANDS[2], { columns: 12 }), '  /sessions');
  assert.equal(formatSlashRow(COMMANDS[2], { selected: true, columns: 12 }), '> /sessions');

  // Selecting changes the marker, never the text.
  assert.equal(
    formatSlashRow(COMMANDS[0], { columns: 40 }).slice(1),
    formatSlashRow(COMMANDS[0], { selected: true, columns: 40 }).slice(1),
  );
  // A command with no description is just its name.
  assert.equal(formatSlashRow({ name: 'x' }, { columns: 40 }), '  /x');

  // The window scrolls instead of overflowing, and the cursor is inside it.
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `cmd${i}`, description: 'x' }));
  const rows = slashRows(many, { index: 11, columns: 40, maxRows: SLASH_MAX_ROWS });
  assert.equal(rows.length, SLASH_MAX_ROWS);
  assert.equal(rows.at(-1).command.name, 'cmd11');
  assert.ok(rows.some((entry) => entry.selected), 'the cursor must be visible');
  // An empty list paints nothing at all.
  assert.deepEqual(slashRows([], { index: 0 }), []);
});

test('createSlashMenu() opens on a query, filters, moves and closes on a space', () => {
  const menu = createSlashMenu({ source: () => COMMANDS });

  // Closed until a slash is typed.
  assert.equal(menu.isOpen, false);
  assert.equal(menu.sync('hello'), false);

  // A bare slash lists every command.
  assert.equal(menu.sync('/'), true);
  assert.equal(menu.isOpen, true);
  assert.equal(menu.matches.length, COMMANDS.length);
  assert.equal(menu.current().name, 'compact');

  // Typing narrows the list and resets the cursor to the best row. `usage` answers `/se`
  // too: `s` then `e` appear in order inside it, which is the subsequence tier working.
  menu.move(2);
  assert.equal(menu.sync('/se'), true);
  assert.deepEqual(names(menu.matches), ['sessions', 'usage']);
  assert.equal(menu.index, 0);

  // A space ends the command name, so the popup goes.
  assert.equal(menu.sync('/sessions '), false);
  assert.equal(menu.isOpen, false);

  // A query nothing answers is closed, not an empty frame.
  assert.equal(menu.sync('/zzz'), false);

  // The move wraps around both ends, like the picker.
  const wrap = createSlashMenu({ source: () => COMMANDS });
  wrap.sync('/');
  wrap.move(-1);
  assert.equal(wrap.current().name, COMMANDS.at(-1).name);
  wrap.move(1);
  assert.equal(wrap.current().name, COMMANDS[0].name);

  // A throwing source cannot take the box down with it.
  const broken = createSlashMenu({ source: () => { throw new Error('registry gone'); } });
  assert.equal(broken.sync('/'), false);
  // A fixed list works too, for a caller with no registry.
  assert.equal(createSlashMenu({ source: COMMANDS }).sync('/he'), true);
});

test('slashCompleteText() completes the name with a space, slashAcceptText() runs it', () => {
  // The two accept paths are different on purpose: Tab leaves room for arguments and
  // does not run anything, Enter runs exactly the command that was highlighted.
  assert.equal(slashCompleteText({ name: 'sessions' }), '/sessions ');
  assert.equal(slashAcceptText({ name: 'sessions' }), '/sessions');
  assert.equal(slashCompleteText(null), '');
  assert.equal(slashAcceptText(null), '');
});

test('claimMenuKey() owns the arrows and Enter only while the menu is open', () => {
  const menu = createSlashMenu({ source: () => COMMANDS });
  const submitted = [];
  const accept = (text) => submitted.push(text);

  // Closed: the key is not the menu's, so the caller keeps its own meaning.
  assert.equal(claimMenuKey({ menu, name: 'down', accept }), false);
  assert.equal(claimMenuKey({ menu: null, name: 'down', accept }), false);

  menu.sync('/se');
  // Open: the arrows move the cursor and are consumed.
  assert.equal(claimMenuKey({ menu, name: 'down', accept }), true);
  assert.equal(menu.current().name, 'usage');
  assert.equal(claimMenuKey({ menu, name: 'up', accept }), true);
  assert.equal(menu.current().name, 'sessions');

  // A key the menu does not use falls through to the box.
  assert.equal(claimMenuKey({ menu, name: 'left', accept }), false);

  // Enter takes the highlighted row and submits it verbatim, and the popup goes with it.
  assert.equal(claimMenuKey({ menu, name: 'enter', accept }), true);
  assert.deepEqual(submitted, ['/sessions']);
  assert.equal(menu.isOpen, false);
});

test('completeMenuKey() puts the completed name in the box and drops the popup', () => {
  const menu = createSlashMenu({ source: () => COMMANDS });
  let written = null;
  const write = (text) => { written = text; };

  // Nothing to complete while closed, so Tab keeps meaning "the mode ring".
  assert.equal(completeMenuKey({ menu, write }), false);
  assert.equal(written, null);

  menu.sync('/se');
  assert.equal(completeMenuKey({ menu, write }), true);
  assert.equal(written, '/sessions ');
  // The space it adds is past the name, so the popup cannot spring back over it.
  assert.equal(menu.isOpen, false);
});

test('createSlashBar() paints the rows, grows to hold them and hides when there are none', () => {
  const menu = createSlashMenu({ source: () => COMMANDS });
  const bar = createSlashBar({ menu, columns: () => 60 });

  // Closed: no rows, no frame, no height.
  assert.deepEqual(bar.paint(), []);
  assert.equal(bar.visible, false);
  assert.equal(bar.height, 0);

  menu.sync('/');
  const rows = bar.paint();
  assert.equal(rows.length, COMMANDS.length);
  assert.equal(bar.height, rows.length);
  assert.equal(bar.visible, true);
  // The selected row is marked in the text, which is what the bar paints.
  assert.ok(rows.some((row) => row.selected && row.text.startsWith('>')));

  // The rows it holds are a snapshot of the menu at paint time.
  assert.deepEqual(bar.rows(), rows);

  menu.sync('');
  assert.deepEqual(bar.paint(), []);
  assert.equal(bar.visible, false);
  bar.close();
});