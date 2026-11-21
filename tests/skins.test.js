import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  SKIN_KEYS, PALETTE_KEYS, DEFAULT_SKIN, DEFAULT_PALETTE,
  normalizeSkin, isColorName, slugName,
  listSkins, readSkin, saveSkin, readActiveName, writeActiveName,
} from '../utils/skins-store.js';
import { BLESSED_COLORS } from '../utils/color-names.js';
import {
  activePalette, activeTokens, setPalette, setTokens, applySkin, resetTheme,
  CONVERSATION_COLORS, SLASH_COLORS, colorizeLine, colorizeIntent,
} from '../app/theme.js';
import { selectedOpen, selectedClose } from '../app/slash-bar.js';
import {
  resolveTags, fgTag, hasSymbolicTags, stripSymbolicTags, symbolicTag, FALLBACK_COLOR,
} from '../app/paint-tags.js';
import { renderTranscriptLines } from '../app/tui-render.js';
import { withTui } from './support/tui-harness.js';
import { formatNoticeRow } from '../app/notice-overlay.js';
import { createInputHint } from '../app/input-hint.js';

/**
 * Skins (`docs/interface/skins`), the **store and the live palette** half: the shape a
 * skin has, the shipped default a project with no file sees, one JSON file per name, the
 * active record, and the in-place mutation that lets a skin repaint a running transcript.
 *
 * The command half lives in `tests/skins-command.test.js` and the `/skins prompt` subchat
 * in `tests/skins-prompt.test.js`. Everything here runs against a throwaway directory
 * under `agent/`, so no real skin is touched.
 */

const dir = `agent/skins-test-${process.pid}`;
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A fresh skins directory per case, so cases cannot see each other's files. */
function freshDir(name) {
  const target = `${dir}/${name}`;
  fs.rmSync(target, { recursive: true, force: true });
  return target;
}

test('the store names the skin shape and keeps the shipped palette as the default', () => {
  assert.deepEqual(
    [...SKIN_KEYS].sort(),
    ['boldIntent', 'boldTracking', 'border', 'brand', 'hint', 'name', 'palette', 'selected', 'selectedFg'].sort(),
  );
  // The eight kinds of row, then the chrome the renderer paints and the three tool
  // families: every colour the screen shows is a palette key, so a skin can move all of
  // them (`app/paint-tags.js`, `docs/interface/skins`).
  assert.deepEqual(PALETTE_KEYS, [
    'user', 'tool', 'intent', 'context', 'error', 'notice', 'tracking', 'refusal',
    'frame', 'table', 'code', 'quote', 'bullet', 'heading',
    'toolRead', 'toolWrite', 'toolBash',
  ]);
  assert.equal(DEFAULT_SKIN.name, 'default');
  assert.equal(DEFAULT_SKIN.palette.intent, 'bright-blue');
  assert.equal(DEFAULT_SKIN.palette.user, 'cyan');
  assert.equal(DEFAULT_PALETTE.tracking, 'bright-green', 'the shipped palette is the default');
  // every default colour is a plain blessed name
  for (const color of Object.values(DEFAULT_PALETTE)) assert.ok(isColorName(color), color);
  assert.equal(slugName('  Warm Sunset '), 'warm-sunset');
  assert.equal(slugName('!!'), '', 'a name with nothing usable left is empty');
});

test('normalizeSkin() fills defaults, drops invented keys and rejects a hex colour', () => {
  const skin = normalizeSkin({ name: 'Neon Night', palette: { user: 'red', tool: '#ff0000', bogus: 'cyan' }, boldIntent: false });
  assert.equal(skin.name, 'neon-night', 'the name is slugged');
  assert.equal(skin.palette.user, 'red', 'a named colour is taken');
  assert.equal(skin.palette.tool, DEFAULT_PALETTE.tool, 'a hex code is not a colour name: it degrades');
  assert.equal(skin.palette.intent, DEFAULT_PALETTE.intent, 'a missing key keeps the default');
  assert.equal(skin.bogus, undefined, 'an invented key is dropped');
  assert.equal(skin.boldIntent, false);
  assert.equal(skin.boldTracking, true, 'an unnamed boolean keeps the default');
  assert.equal(isColorName('bright-blue'), true);
  assert.equal(isColorName('#00ff00'), false, 'a hex code is refused');
  assert.equal(isColorName('orange'), false, 'a name blessed cannot paint is refused, not printed literally');
  assert.equal(isColorName('Cyan'), false, 'a non-canonical spelling is refused');
  assert.equal(isColorName(''), false);

  // a non-object normalises to the default rather than throwing
  assert.equal(normalizeSkin(null).name, 'default');
  assert.equal(normalizeSkin(42).palette.user, DEFAULT_PALETTE.user);
});

test('isColorName() accepts only the names a blessed tag really paints', () => {
  // The regression: the old pattern accepted `orange` — the example the docs used — and a
  // blessed tag it does not know is printed **literally**, so the row showed
  // `{orange-fg}…{/orange-fg}` instead of a colour. The vocabulary is a closed set.
  for (const color of BLESSED_COLORS) assert.ok(isColorName(color), color);
  assert.ok(isColorName('bright-blue') && isColorName('cyan') && isColorName('grey'));
  assert.equal(isColorName('orange'), false, 'a name blessed cannot paint is refused');
  assert.equal(isColorName('bright-orange'), false);
  assert.equal(isColorName('purple'), false);
  assert.equal(isColorName('#00ff00'), false, 'a hex code is refused');
  assert.equal(isColorName('Cyan'), false, 'a non-canonical spelling is refused');
  assert.equal(isColorName(''), false);
  // and every shipped default really is in the vocabulary
  for (const color of Object.values(DEFAULT_PALETTE)) assert.ok(isColorName(color), color);
});

test('saveSkin() writes one JSON file per name and listSkins() reports it', () => {
  const folder = freshDir('save');
  const saved = saveSkin({ name: 'warm', palette: { intent: 'bright-yellow' } }, { dir: folder });
  assert.equal(saved.path, `${folder}/warm.json`);
  assert.equal(saved.created, true);
  assert.ok(fs.existsSync(`${folder}/warm.json`), 'the file is really on disk');

  const listed = listSkins({ dir: folder });
  assert.equal(listed[0].name, 'default', 'the built-in is always first');
  assert.equal(listed[0].builtin, true);
  assert.equal(listed[1].name, 'warm');
  assert.equal(listed[1].palette.intent, 'bright-yellow');
  assert.equal(readSkin('warm', { dir: folder }).palette.intent, 'bright-yellow');
  assert.equal(readSkin('nope', { dir: folder }), null);
  assert.equal(readSkin('default', { dir: folder }).builtin, true, 'the built-in needs no file');

  // an unreadable file is reported, never hidden
  fs.writeFileSync(`${folder}/broken.json`, '{not json');
  const withBroken = listSkins({ dir: folder });
  const broken = withBroken.find((entry) => entry.name === 'broken');
  assert.ok(broken.error, 'the corrupt file is named, not dropped');
});

test('the active skin is remembered in agent/skins/active.json, and a corrupt record falls back', () => {
  const folder = freshDir('active');
  assert.equal(readActiveName({ dir: folder }), 'default', 'nothing saved yet');
  writeActiveName('Warm', { dir: folder });
  assert.equal(readActiveName({ dir: folder }), 'warm');
  assert.ok(fs.existsSync(`${folder}/active.json`));
  fs.writeFileSync(`${folder}/active.json`, '{not json');
  assert.equal(readActiveName({ dir: folder }), 'default', 'a corrupt record is not an error');
});

test('applying a skin repaints the conversation already on screen', async () => {
  // The regression this pins: the transcript used to store *already-coloured* rows, so a
  // skin repainted the chrome and left every row on screen in the colour it was written
  // with — "I apply a skin and nothing happens". The palette must be applied at *paint*
  // time, from the uncoloured source, or this case fails exactly the way the user saw.
  await withTui(async (tui) => {
    tui.log('You:');
    tui.log('> a prompt that was on screen before the skin');
    await new Promise((resolve) => setImmediate(resolve));

    const frame = () => tui.transcript.getContent();
    assert.match(frame(), /\x1b\[36m/, 'the user row is cyan before the skin');

    applySkin({ name: 'probe', palette: { user: 'red' } });
    tui.repaintTheme();
    await new Promise((resolve) => setImmediate(resolve));

    assert.match(frame(), /\x1b\[31m/, 'the same row is red after the skin');
    assert.doesNotMatch(frame(), /\x1b\[36m/, 'and no longer cyan');
    assert.match(frame().replace(/\x1b\[[\d;]*m/g, ''), /a prompt that was on screen before the skin/,
      'the visible text is unchanged');
    resetTheme();
  });
});
test('a skin moves the tool rows: the kind colour is live, the families are not', () => {
  // A tool row that names no known tool is painted with the *live* kind colour
  // (`CONVERSATION_COLORS.tool`), so a skin really reaches it; the three named families
  // (read/write/bash) keep their own fixed colours by design.
  try {
    setPalette({ tool: 'red' });
    assert.equal(
      colorizeLine('  -> Calling update_task(action: list)'),
      '{red-fg}  -> Calling update_task(action: list){/red-fg}',
      'an unclassified tool row follows the skin',
    );
    assert.equal(
      colorizeLine('  -> Calling read_file(path: x)'),
      '{bright-cyan-fg}  -> Calling read_file(path: x){/bright-cyan-fg}',
      'a named family keeps its own colour',
    );
  } finally {
    resetTheme();
  }
});
test('the palette and the tokens are live: setPalette/applySkin/resetTheme move them in place', () => {
  const original = activePalette();
  try {
    assert.equal(CONVERSATION_COLORS.user, 'cyan');
    const moved = setPalette({ user: 'green', bogus: 'x' });
    assert.equal(moved.user, 'green');
    assert.equal(CONVERSATION_COLORS.user, 'green', 'the object itself was mutated, not replaced');
    assert.equal(colorizeLine('You:'), '{green-fg}You:{/green-fg}', 'the consumer reads the live value');

    applySkin({ name: 'x', palette: { intent: 'bright-yellow' }, boldIntent: false, border: 'magenta' });
    assert.equal(CONVERSATION_COLORS.intent, 'bright-yellow');
    assert.equal(activeTokens().border, 'magenta');
    assert.equal(colorizeIntent('i'), '{bright-yellow-fg}i{/bright-yellow-fg}', 'the bold is dropped by the token');

    resetTheme();
    assert.equal(CONVERSATION_COLORS.user, 'cyan');
    assert.equal(CONVERSATION_COLORS.intent, 'bright-blue');
    assert.equal(activeTokens().boldIntent, true);
    assert.equal(colorizeIntent('i'), '{bright-blue-fg}{bold}i{/bold}{/bright-blue-fg}');
  } finally {
    setPalette(original);
    resetTheme();
  }
});

test('the slash bar, the notice rows and the input hint read the live palette', () => {
  try {
    setPalette({ notice: 'bright-yellow', user: 'bright-green' });
    assert.match(formatNoticeRow({ kind: 'info', text: 'hi' }), /bright-yellow/,
      'the notice colour is read live, not snapshotted');
    assert.match(colorizeLine('You:'), /bright-green/, 'and so is the palette the slash bar sits on');

    // the band open/close markers come from SLASH_COLORS at paint time
    setTokens({ selected: 'magenta', selectedFg: 'black', border: 'bright-cyan' });
    assert.match(selectedOpen(), /\{magenta-bg\}\{black-fg\}/);
    assert.match(selectedClose(), /\{\/black-fg\}\{\/magenta-bg\}/);
    assert.equal(SLASH_COLORS.selected, 'magenta', 'the live object was mutated');

    // the input hint greys the box in the live hint token
    setTokens({ hint: 'bright-black' });
    const fakeBox = { style: {}, getValue: () => '', setContent() {}, on() {} };
    const hint = createInputHint({ inputBox: fakeBox });
    hint.note('last prompt');
    hint.apply();
    assert.equal(fakeBox.style.fg, 'bright-black', 'the hint reads the live hint token');
  } finally {
    resetTheme();
  }
});

test('the tag layer resolves a palette key to the live colour, and never leaks a symbol', () => {
  // The regression this pins: a paint site wrote `{cyan-fg}` by hand, so a fence or a table
  // frame kept its colour through a skin and the screen "did not change". A symbolic tag
  // names the palette key instead and is resolved at paint time.
  assert.equal(resolveTags('{@frame-fg}┌─ js ─{/@frame-fg}', { frame: 'magenta' }),
    '{magenta-fg}┌─ js ─{/magenta-fg}');
  assert.equal(resolveTags('{@quote-fg}│ quoted{/@quote-fg}', { quote: 'bright-yellow' }),
    '{bright-yellow-fg}│ quoted{/bright-yellow-fg}');

  // The palette moved between two calls: the same bytes resolve to the new colour.
  const line = '{@bullet-fg}•{/@bullet-fg} an item';
  assert.equal(resolveTags(line, { bullet: 'green' }), '{green-fg}•{/green-fg} an item');
  assert.equal(resolveTags(line, { bullet: 'red' }), '{red-fg}•{/red-fg} an item');

  // An unknown key, an unpaintable value and a hex code all fall back rather than reaching
  // the screen: blessed prints a tag it cannot parse literally, so a leak would be visible.
  // The fallback is `default`, which resolves to no tag at all — so a bad key leaves the
  // glyphs and the width intact instead of painting or printing a tag.
  assert.equal(resolveTags('{@nope-fg}x{/@nope-fg}', { frame: 'cyan' }), 'x');
  assert.equal(resolveTags('{@frame-fg}x{/@frame-fg}', { frame: 'orange' }), 'x');
  assert.equal(resolveTags('{@frame-fg}x{/@frame-fg}', { frame: '#ff0000' }), 'x');
  assert.equal(FALLBACK_COLOR, 'default');

  // `default` IS the absence of a colour, so it resolves to no tag at all — which is what
  // keeps a skin-less project's bytes identical to what they were before the layer existed.
  assert.equal(resolveTags('{@heading-fg}Title{/@heading-fg}', { heading: 'default' }), 'Title');
  assert.equal(resolveTags('plain text', { frame: 'cyan' }), 'plain text', 'nothing to resolve');

  // A plain colour name goes through the same door, and an invalid one is refused there.
  assert.equal(fgTag('cyan', 'x'), '{cyan-fg}x{/cyan-fg}');
  assert.equal(fgTag('orange', 'x'), 'x', 'an invalid name leaves the body unpainted');
  assert.equal(fgTag('cyan', ''), '', 'an empty body gets no tag');

  // The helpers a render site needs to build and test a symbolic tag.
  assert.equal(symbolicTag('code', 'x'), '{@code-fg}x{/@code-fg}');
  assert.equal(hasSymbolicTags('{@code-fg}x{/@code-fg}'), true);
  assert.equal(hasSymbolicTags('{cyan-fg}x{/cyan-fg}'), false);
  assert.equal(stripSymbolicTags('{@code-fg}x{/@code-fg}'), 'x');
});

test('the renderer emits symbolic tags, so a skin moves a fence, a table frame and a quote', () => {
  // The literal this replaces: `app/tui-render.js` used to write `{cyan-fg}` for a fence and
  // a file delimiter and `{bright-white}` for a quote, so those rows were frozen at render
  // time and a skin could not touch them.
  const rendered = renderTranscriptLines(['```js', 'const x = 1;', '```', '> quoted', '- item'].join('\n'));
  const text = rendered.join('\n');
  assert.match(text, /\{@frame-fg\}/, 'the fence names the frame key');
  assert.match(text, /\{@quote-fg\}/, 'the quote names the quote key');
  assert.match(text, /\{@bullet-fg\}/, 'the bullet names the bullet key');
  assert.doesNotMatch(text, /\{cyan-fg\}/, 'no raw colour literal survives in the renderer');

  // And the whole path resolves: a skin that moves every key repaints the same source.
  try {
    setPalette({ frame: 'red', quote: 'red', bullet: 'red', code: 'red' });
    const painted = colorizeLine(rendered.join('\n'));
    assert.match(painted, /\{red-fg\}/, 'the resolved colour follows the skin');
    assert.doesNotMatch(painted, /\{@/, 'no symbolic tag survives to the screen');
  } finally {
    resetTheme();
  }
});
