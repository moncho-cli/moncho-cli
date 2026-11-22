import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  applyProjectSkin, currentSkin, rememberAppliedSkin, restoreSessionSkin,
} from '../app/skin-host.js';
import { activePalette, activeSkinName, resetTheme, isSkinBootstrapped } from '../app/theme.js';
import { saveSkin, writeActiveName, readSkin } from '../utils/skins-store.js';
import { createLogger } from '../utils/logger.js';
import { registerLogger, clearLogger } from '../utils/host.js';

/**
 * The project's look as the host wires it (`docs/interface/skins`).
 *
 * Three rules matter and each one is a bug when broken:
 *
 *  - the project's active skin is applied **before** the screen is built, so the first
 *    frame already wears it;
 *  - applying a skin mid-session remembers it as the *project's*, so the next launch opens
 *    in it;
 *  - a **resumed** session restores its own recorded look, and that restore is refused
 *    before the startup bootstrap — otherwise the project's skin would overwrite the
 *    session's choice.
 */

const DIR = `agent/skins-host-test-${process.pid}`;

const cleanup = () => {
  try {
    fs.rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* nothing to clean */
  }
  resetTheme();
};

test('applyProjectSkin() applies the stored active skin and returns it', () => {
  cleanup();
  try {
    saveSkin({ name: 'matrix', palette: { intent: 'green', user: 'green' } }, { dir: DIR });
    writeActiveName('matrix', { dir: DIR });

    const applied = applyProjectSkin({ dir: DIR });
    assert.equal(applied?.name, 'matrix', 'the stored skin was applied');
    assert.equal(activePalette().intent, 'green', 'the palette moved');
    assert.equal(currentSkin(), 'matrix', 'and the live reader names it');
    assert.equal(isSkinBootstrapped(), true, 'the bootstrap was marked');
  } finally {
    cleanup();
  }
});

test('applyProjectSkin() with no stored skin opens in the built-in default and still bootstraps', () => {
  cleanup();
  try {
    const applied = applyProjectSkin({ dir: DIR });
    // The built-in default is a skin like any other: a project with no file opens in it,
    // which is exactly the look it always had.
    assert.equal(applied?.name, 'default', 'the shipped default is what a project with no file opens in');
    assert.equal(activePalette().intent, 'bright-blue', 'the shipped palette');
    assert.equal(isSkinBootstrapped(), true, 'and a resume is licensed to restore');
  } finally {
    cleanup();
  }
});

test('rememberAppliedSkin() writes the applied skin as the project default and repaints', () => {
  cleanup();
  try {
    const repaints = [];
    rememberAppliedSkin({ name: 'neon' }, { dir: DIR, repaint: () => repaints.push('paint') });

    assert.equal(readSkin('neon', { dir: DIR }), null, 'the file is the command\'s business, not the host\'s');
    assert.equal(repaints.length, 1, 'the chrome was repainted');

    // A nameless skin cannot be remembered, but the repaint hook still runs: the caller may
    // have moved the palette and only needs the chrome refreshed.
    const before = repaints.length;
    rememberAppliedSkin(null, { dir: DIR, repaint: () => repaints.push('paint') });
    assert.equal(repaints.length, before + 1, 'the repaint hook still runs');
    assert.doesNotThrow(() => rememberAppliedSkin(null, { dir: DIR }), 'and no hook is required');
  } finally {
    cleanup();
  }
});

test('restoreSessionSkin() is refused before the bootstrap and applies the file after it', () => {
  cleanup();
  try {
    // Before the startup bootstrap nothing is licensed to restore: the project's skin must
    // not be overwritten by a session's older choice.
    assert.equal(restoreSessionSkin('matrix', { dir: DIR }), false, 'refused before the bootstrap');

    applyProjectSkin({ dir: DIR });
    saveSkin({ name: 'matrix', palette: { intent: 'green' } }, { dir: DIR });

    const repaints = [];
    assert.equal(restoreSessionSkin('matrix', { dir: DIR, repaint: () => repaints.push('paint') }), true);
    assert.equal(activePalette().intent, 'green', 'the session\'s recorded look was applied');
    assert.equal(repaints.length, 1, 'and the chrome was repainted');

    // A session that recorded no skin, or one whose file is gone, restores nothing.
    assert.equal(restoreSessionSkin(null, { dir: DIR }), false, 'no stored name restores nothing');
    assert.equal(restoreSessionSkin('deleted-skin', { dir: DIR }), false, 'a missing file restores nothing');
    assert.equal(activeSkinName(), 'matrix', 'the look stayed where it was');
  } finally {
    cleanup();
  }
});

test('a stored skin whose band blessed cannot paint is named in the log when it is applied', () => {
  // The only place a refused name still exists: the store degrades a colour blessed cannot
  // paint to the shipped one, so the band quietly keeps its old colour and the screen looks
  // unchanged. Reading the raw file is what lets the log say why.
  //
  // The name is `orange`, not `bright-blue`: blessed paints a bright background as well as
  // a bright foreground, so a stored `bright-blue` band is honoured rather than refused
  // (`tests/skins-colors.test.js` proves it through a real widget).
  cleanup();
  const file = `${DIR}/moncho.log`;
  const logger = createLogger({ file, level: 'info' });
  registerLogger(logger);
  try {
    saveSkin({ name: 'rainbowish', palette: { intent: 'bright-red' } }, { dir: DIR });
    // Write the raw file by hand: `saveSkin()` normalizes, and this is the older-run shape.
    const raw = JSON.parse(fs.readFileSync(`${DIR}/rainbowish.json`, 'utf-8'));
    raw.selected = 'orange';
    raw.userBg = 'chartreuse';
    fs.writeFileSync(`${DIR}/rainbowish.json`, JSON.stringify(raw));
    writeActiveName('rainbowish', { dir: DIR });

    const applied = applyProjectSkin({ dir: DIR });
    assert.equal(applied?.name, 'rainbowish', 'the stored skin is still applied');
    assert.equal(applied?.selected, 'blue', 'but its band degrades to a paintable name');

    const text = fs.readFileSync(file, 'utf-8');
    assert.match(text, /background colour refused/, 'the log says why the band did not move');
    assert.match(text, /"key":"selected"/, 'and names the token');
    assert.match(text, /"value":"orange"/, 'and the value it refused');
    assert.match(text, /"key":"userBg"/, 'both refused bands, not only the first');
  } finally {
    clearLogger();
    cleanup();
  }
});
