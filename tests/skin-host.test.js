import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  applyProjectSkin, currentSkin, rememberAppliedSkin, restoreSessionSkin,
} from '../app/skin-host.js';
import { activePalette, activeSkinName, resetTheme, isSkinBootstrapped } from '../app/theme.js';
import { saveSkin, writeActiveName, readSkin } from '../utils/skins-store.js';

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
