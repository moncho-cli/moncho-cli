import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_FAMILIES, TOOL_COLORS, toolFamily, toolColorFor, toolNameOf,
} from '../app/tool-palette.js';
import { CONVERSATION_COLORS, TRACKING_COLOR, classifyLine, colorizeLine } from '../app/theme.js';
import { formatTranscript } from '../app/tui-render.js';
import { withTui, plainText, visible } from './support/tui-harness.js';

/**
 * The per-operation tool palette (task-backlog: "use different colors for read, write,
 * and bash type of operations so they are easy trackable in the conversation at a
 * glance").
 *
 * The pure half is the mapping and the two regexes that recover a tool name from a
 * rendered row; the second half proves the colours really reach the screen and that a
 * write can never be mistaken for the `[Tracking]` milestone painted next to it.
 */

const flush = async (rounds = 3) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('each tool name maps to its operation family, and an unknown name to other', () => {
  assert.deepEqual(TOOL_FAMILIES, {
    read_file: 'read',
    hint_file: 'read',
    blob: 'read',
    grep: 'read',
    read_capture: 'read',
    web_fetch: 'read',
    write_file: 'write',
    edit_file: 'write',
    delete_file: 'write',
    write_plan_md: 'write',
    edit_plan_md: 'write',
    run_bash: 'bash',
    run_npm: 'bash',
  });

  for (const [name, family] of Object.entries(TOOL_FAMILIES)) {
    assert.equal(toolFamily(name), family, name);
  }
  // Anything unlisted is `other`, never a guess: an unknown tool must not be painted as
  // a write, because "the tree changed" is a claim the palette may not make casually.
  for (const name of ['update_task', 'compact_context', 'nope', '', null, undefined, 42]) {
    assert.equal(toolFamily(name), 'other', String(name));
  }
});

test('the family colours are the agreed ones, and a write never reads as tracking', () => {
  assert.deepEqual(TOOL_COLORS, {
    read: 'bright-cyan',
    write: 'green',
    bash: 'yellow',
    other: 'yellow',
  });
  // Plain cyan is the user's own echo, so a read may not borrow it.
  assert.notEqual(TOOL_COLORS.read, CONVERSATION_COLORS.user);
  // A write is plain green: the bright green belongs to a [Tracking] milestone.
  assert.notEqual(TOOL_COLORS.write, TRACKING_COLOR);
  // The fallback for a row that names no tool is the kind's own colour.
  assert.equal(TOOL_COLORS.other, CONVERSATION_COLORS.tool);
});

test('toolColorFor resolves a tool name, a family name and junk', () => {
  assert.equal(toolColorFor('read_file'), 'bright-cyan');
  assert.equal(toolColorFor('blob'), 'bright-cyan');
  assert.equal(toolColorFor('write_file'), 'green');
  assert.equal(toolColorFor('edit_file'), 'green');
  assert.equal(toolColorFor('delete_file'), 'green');
  // The design mode's own writers are writers too: a document changed is a tree changed,
  // so a reader sees them in the same green as any other write.
  assert.equal(toolColorFor('write_plan_md'), 'green');
  assert.equal(toolColorFor('edit_plan_md'), 'green');
  assert.equal(toolColorFor('run_bash'), 'yellow');
  assert.equal(toolColorFor('run_npm'), 'yellow');
  // A family name passes straight through, which is what the fallback path needs.
  assert.equal(toolColorFor('read'), 'bright-cyan');
  assert.equal(toolColorFor('write'), 'green');
  assert.equal(toolColorFor('bash'), 'yellow');
  assert.equal(toolColorFor('other'), 'yellow');
  assert.equal(toolColorFor('update_task'), 'yellow');
  assert.equal(toolColorFor('not a tool'), 'yellow');
  assert.equal(toolColorFor(undefined), 'yellow');

  // The `other` family is the **live** kind colour a skin may move: the caller passes it
  // in, so an unclassified tool row follows the skin while the named families do not.
  assert.equal(toolColorFor('update_task', { fallback: 'red' }), 'red');
  assert.equal(toolColorFor('other', { fallback: 'red' }), 'red');
  assert.equal(toolColorFor('read_file', { fallback: 'red' }), 'bright-cyan', 'a named family keeps its own colour');
});
test('toolNameOf recovers the tool from a call line and from an output header', () => {
  assert.equal(toolNameOf('  -> Calling read_file(path: app/tui.js)'), 'read_file');
  assert.equal(toolNameOf('-> Calling run_bash(command: ls)'), 'run_bash');
  assert.equal(toolNameOf('  [write_file Output] (intent: rewrite it)'), 'write_file');
  // main.js prefixes the header with a newline, and a collapsed block carries it inside
  // a longer row — both still name the tool.
  assert.equal(toolNameOf('\n  [delete_file Output]'), 'delete_file');
  assert.equal(toolNameOf('▸   [read_file Output] — 40 char response (click to expand)'), 'read_file');
  // A row that names no tool answers null, so the caller falls back to the kind colour.
  assert.equal(toolNameOf('▸ some prose'), null);
  assert.equal(toolNameOf('[Context] 1.2k / 8.0k tokens'), null);
  assert.equal(toolNameOf('-> Calling'), null);
  assert.equal(toolNameOf(''), null);
  assert.equal(toolNameOf(undefined), null);
});

test('a read row is bright cyan, a write row green and a shell row yellow', () => {
  assert.equal(
    colorizeLine('  -> Calling read_file(path: app/tui.js)'),
    '{bright-cyan-fg}  -> Calling read_file(path: app/tui.js){/bright-cyan-fg}',
  );
  assert.equal(
    colorizeLine('  [blob Output]'),
    '{bright-cyan-fg}  [blob Output]{/bright-cyan-fg}',
  );
  assert.equal(
    colorizeLine('  -> Calling write_file(path: a.js)'),
    '{green-fg}  -> Calling write_file(path: a.js){/green-fg}',
  );
  assert.equal(
    colorizeLine('  [delete_file Output]'),
    '{green-fg}  [delete_file Output]{/green-fg}',
  );
  assert.equal(
    colorizeLine('  -> Calling run_bash(command: ls)'),
    '{yellow-fg}  -> Calling run_bash(command: ls){/yellow-fg}',
  );
  // A tool this palette does not know keeps the kind's own colour, and so does a row
  // that names no tool at all.
  assert.equal(
    colorizeLine('  -> Calling update_task(action: list)'),
    '{yellow-fg}  -> Calling update_task(action: list){/yellow-fg}',
  );
  assert.equal(
    colorizeLine('  -> Calling mystery_tool()'),
    '{yellow-fg}  -> Calling mystery_tool(){/yellow-fg}',
  );

  // A collapsed block header carries the name mid-row, so the family colour finds it
  // there too, and the width of the row is untouched (the click math depends on it).
  const header = '▸   [write_file Output] — 40 char response (click to expand)';
  const painted = colorizeLine(header);
  assert.equal(painted, `{green-fg}${header}{/green-fg}`);
  assert.equal(painted.replace(/\{[^}]+\}/g, ''), header);

  // Inside a read header the intent span still turns, and the row keeps its own colour.
  assert.equal(
    colorizeLine('  [read_file Output] (intent: check the layout)'),
    '{bright-cyan-fg}  [read_file Output] '
      + '{bright-blue-fg}{bold}(intent: check the layout){/bold}{/bright-blue-fg}{/bright-cyan-fg}',
  );

  // The family colour also survives the end of the markdown renderer, which is where the
  // palette is really applied.
  const rendered = formatTranscript('  -> Calling grep(pattern: needle)\nplain prose').split('\n');
  assert.equal(rendered[0], '{bright-cyan-fg}  -> Calling grep(pattern: needle){/bright-cyan-fg}');
  assert.equal(rendered[1], 'plain prose');
});

test('a write and a [Tracking] row are still told apart on screen', async () => {
  await withTui(async (tui, { painted }) => {
    tui.log('  -> Calling write_file(path: app/a.js)');
    tui.log('[Tracking] task.md · "one" done');
    await flush();

    const frame = painted();
    // The widget content carries each tag's own escape while the painted stream reduces
    // it for an 8-colour terminal, so the colours are probed where they are exact.
    const content = tui.transcript.getContent();
    const write = content.indexOf('Calling write_file');
    const tracking = content.indexOf('[Tracking]');
    assert.ok(write >= 0 && tracking >= 0, 'both rows were painted');

    // 32 = green (the write family), 92 = bright green (the milestone) plus bold
    assert.match(content.slice(Math.max(0, write - 20), write), /\x1b\[32m/, 'a write is green');
    assert.match(content.slice(Math.max(0, tracking - 24), tracking), /\x1b\[(?:1;92|92|1;32|32)m/, 'tracking is bright green');
    assert.doesNotMatch(content.slice(Math.max(0, tracking - 24), tracking), /\x1b\[(?:1;33|33)m/, 'a milestone is never the tool yellow');

    // ... and the glyphs are unchanged: colour is presentation only.
    assert.match(visible(tui), /Calling write_file\(path: app\/a\.js\)/);
    assert.doesNotMatch(plainText(frame), /-fg\}/, 'no blessed tag leaks as text');

    // The classification is unchanged by the family work: both rows are what they were.
    assert.equal(classifyLine('[read_file Output]'), 'tool');
    assert.equal(classifyLine('[Tracking] done'), 'tracking');
  });
});
