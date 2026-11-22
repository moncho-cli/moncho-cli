import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  SKIN_KEYS, PALETTE_KEYS, PRESENTATION_KEYS, DEFAULT_SKIN, DEFAULT_PALETTE,
  normalizeSkin, isColorName, slugName,
  listSkins, readSkin, saveSkin, readActiveName, writeActiveName,
} from '../utils/skins-store.js';
import { BLESSED_COLORS } from '../utils/color-names.js';

/**
 * Skins (`docs/interface/skins`), the **store** half: the shape a skin has, the shipped
 * default a project with no file sees, one JSON file per name, and the active record.
 *
 * The live-palette half lives in `tests/skins.test.js`, the command half in
 * `tests/skins-command.test.js` and the `/skins prompt` subchat in
 * `tests/skins-prompt.test.js`. Everything here runs against a throwaway directory under
 * `agent/`, so no real skin is touched.
 */

const dir = `agent/skins-store-test-${process.pid}`;
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
    ['boldIntent', 'boldTracking', 'border', 'brand', 'hint', 'name', 'palette', 'selected', 'selectedFg', 'userBg', 'assistantBg'].sort(),
  );
  // The two prose backgrounds are presentation tokens, not palette keys: a band is a
  // background over a whole row, not the foreground of a row's kind. Naming them is what
  // lets a request for a background actually reach the screen.
  assert.deepEqual(
    PRESENTATION_KEYS,
    ['border', 'brand', 'hint', 'selected', 'selectedFg', 'userBg', 'assistantBg', 'boldIntent', 'boldTracking'],
  );
  assert.equal(DEFAULT_SKIN.userBg, 'blue');
  assert.equal(DEFAULT_SKIN.assistantBg, 'red');
  assert.notEqual(DEFAULT_SKIN.userBg, DEFAULT_SKIN.assistantBg, 'the two sides never read alike');
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
