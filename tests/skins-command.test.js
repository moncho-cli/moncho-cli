import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { saveSkin, readSkin, readActiveName, writeActiveName } from '../utils/skins-store.js';
import { activePalette, applySkin, resetTheme } from '../app/theme.js';
import { parseSkinsArgs, skinsCommand } from '../app/skins-command.js';

/**
 * `/skins` (`docs/interface/skins`), the **command** half: the grammar it accepts and the
 * six shapes it answers — list, apply, save, build-and-save, reset, prompt.
 *
 * Every case runs against a throwaway directory under `agent/`, so no real skin is
 * touched; the store half (`utils/skins-store.js`) is proved in `tests/skins.test.js` and
 * the `/skins prompt` subchat in `tests/skins-prompt.test.js`.
 */

const dir = `agent/skins-cmd-test-${process.pid}`;
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A fresh skins directory per case, so cases cannot see each other's files. */
function freshDir(name) {
  const target = `${dir}/${name}`;
  fs.rmSync(target, { recursive: true, force: true });
  return target;
}

/** A command bound to one throwaway directory, with the apply hook recorded. */
function makeCommand(name) {
  const folder = freshDir(name);
  const applied = [];
  const cmd = skinsCommand();
  const run = (arg, extra = {}) => cmd.run({
    arg, skinsDir: folder, onApply: (skin) => applied.push(skin?.name ?? skin), ...extra,
  });
  return { folder, applied, run };
}

test('parseSkinsArgs() splits list, reset, save, prompt, apply and build-and-save', () => {
  assert.deepEqual(parseSkinsArgs(''), { action: 'list' });
  assert.deepEqual(parseSkinsArgs('list'), { action: 'list' });
  assert.deepEqual(parseSkinsArgs('reset'), { action: 'reset' });
  assert.deepEqual(parseSkinsArgs('save warm'), { action: 'save', name: 'warm' });
  assert.deepEqual(parseSkinsArgs('prompt a neon look'), { action: 'prompt', request: 'a neon look' });
  assert.deepEqual(parseSkinsArgs('customize make it warmer'), { action: 'customize', request: 'make it warmer' });
  assert.deepEqual(parseSkinsArgs('warm'), { action: 'apply', name: 'warm', saveAs: 'warm', pairs: {} });
  const build = parseSkinsArgs('warm intent=bright-yellow user=cyan save warm');
  assert.equal(build.action, 'apply-save');
  assert.equal(build.name, 'warm');
  assert.equal(build.saveAs, 'warm');
  assert.deepEqual(build.pairs, { intent: 'bright-yellow', user: 'cyan' });
  assert.equal(parseSkinsArgs('warm nope').action, 'unknown');
});

test('/skins lists the skins and flags the active one', async () => {
  const { folder, run } = makeCommand('list');
  saveSkin({ name: 'warm', palette: { intent: 'bright-yellow' } }, { dir: folder });
  writeActiveName('warm', { dir: folder });

  const result = await run('');
  assert.equal(result.ok, true);
  assert.equal(result.code, 'LISTED');
  assert.equal(result.active, 'warm');
  assert.ok(result.lines.some((line) => line.includes('warm (active)')), 'the active skin is flagged');
  assert.ok(result.lines[0].includes('default'), 'the built-in is listed too');
});

test('/skins <name> applies a skin and remembers it, and refuses an unknown one', async () => {
  const { folder, run, applied } = makeCommand('apply');
  saveSkin({ name: 'warm', palette: { intent: 'bright-yellow' } }, { dir: folder });
  try {
    const appliedResult = await run('warm');
    assert.equal(appliedResult.code, 'APPLIED');
    assert.equal(activePalette().intent, 'bright-yellow', 'the running palette moved');
    assert.equal(readActiveName({ dir: folder }), 'warm', 'the project remembers it');
    assert.deepEqual(applied, ['warm'], 'the repaint hook fired');

    const unknown = await run('ghost');
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, 'UNKNOWN_SKIN');
  } finally {
    resetTheme();
  }
});

test('/skins builds a new look from tokens and writes it down with save', async () => {
  const { folder, run } = makeCommand('build');
  try {
    const result = await run('warm intent=bright-yellow user=bright-magenta save warm');
    assert.equal(result.code, 'SAVED', 'the look was written down');
    assert.equal(result.skin.name, 'warm');
    const onDisk = readSkin('warm', { dir: folder });
    assert.equal(onDisk.palette.intent, 'bright-yellow');
    assert.equal(onDisk.palette.user, 'bright-magenta');
    assert.equal(activePalette().user, 'bright-magenta', 'and it is on screen');

    const bad = await run('warm intent=#ff0000');
    assert.equal(bad.code, 'BAD_VALUE');
  } finally {
    resetTheme();
  }
});

test('/skins builds a look under a new name without writing it down', async () => {
  // The regression: the APPLIED branch read `known.name`, and `known` is null for a name
  // that has no file yet — so `/skins sunset intent=bright-yellow` (build, do not save) crashed
  // with a TypeError instead of putting the look on.
  const { folder, run } = makeCommand('build-nosave');
  try {
    const built = await run('sunset intent=bright-yellow user=bright-magenta');
    assert.equal(built.code, 'APPLIED', 'the look was applied, not refused');
    assert.equal(built.skin.name, 'sunset');
    assert.equal(activePalette().intent, 'bright-yellow');
    assert.equal(activePalette().user, 'bright-magenta');
    assert.equal(readSkin('sunset', { dir: folder }), null, 'and nothing was written');
  } finally {
    resetTheme();
  }
});

test('/skins names the value it refused, and the colours it will take', async () => {
  // The regression this pins: the refusal named the *key* (`"intent" is not a colour`),
  // so the user read a message about their argument and not about the word they got wrong.
  const { run } = makeCommand('refusal');
  const bad = await run('warm intent=orange');
  assert.equal(bad.code, 'BAD_VALUE');
  assert.match(bad.message, /"orange"/, 'the value is named');
  assert.match(bad.message, /intent=orange/, 'and the argument it came from');
  assert.match(bad.message, /bright-blue/, 'and a colour that really works');

  const badBool = await run('warm boldIntent=yes');
  assert.equal(badBool.code, 'BAD_VALUE');
  assert.match(badBool.message, /true or false/, 'a boolean mistake is not called a colour');

  const badKey = await run('warm nope=red');
  assert.equal(badKey.code, 'BAD_VALUE');
  assert.match(badKey.message, /not a skin token/);
});

test('/skins reset restores the shipped default', async () => {
  const { folder, run } = makeCommand('reset');
  saveSkin({ name: 'warm', palette: { intent: 'bright-yellow' } }, { dir: folder });
  applySkin({ palette: { intent: 'bright-yellow' } });
  const result = await run('reset');
  assert.equal(result.code, 'RESET');
  assert.equal(activePalette().intent, 'bright-blue');
  assert.equal(readActiveName({ dir: folder }), 'default');
});

test('/skins prompt refuses without a subchat and applies the confirmed proposal', async () => {
  const { run } = makeCommand('prompt');
  try {
    const refused = await run('prompt a neon look');
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'NO_SUBCHAT');

    const appliedResult = await run('prompt warm it up', {
      skinSubchat: async () => ({ name: 'sunset', palette: { intent: 'bright-yellow' } }),
    });
    assert.equal(appliedResult.code, 'PROPOSED');
    assert.equal(activePalette().intent, 'bright-yellow', 'the confirmed proposal was applied');

    const cancelled = await run('prompt warm it up', { skinSubchat: async () => null });
    assert.equal(cancelled.code, 'CANCELLED');
    assert.equal(cancelled.message, 'No skin applied; the look is unchanged.', 'a no-op says so on screen');
  } finally {
    resetTheme();
  }
});

test('/skins customize updates the active skin in place and never creates a new one', async () => {
  const { folder, run } = makeCommand('customize');
  try {
    // No active skin: there is nothing to update, so the command refuses instead of
    // inventing a skin — creating one is `/skins prompt`'s job. A subchat is supplied so
    // the refusal comes from the missing skin, not from the missing front end.
    const refused = await run('customize make it warmer', { skinSubchat: async () => null });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'NO_ACTIVE_SKIN');
    assert.equal(readSkin('warm', { dir: folder }), null, 'nothing was written');

    saveSkin({ name: 'warm', palette: { intent: 'bright-yellow' } }, { dir: folder });
    writeActiveName('warm', { dir: folder });

    // The subchat is asked to customize: the options say so, and the base is the active skin.
    let asked = null;
    const customized = await run('customize make the intent brighter', {
      skinSubchat: async (request, options) => {
        asked = { request, options };
        return { skin: { name: 'warm', palette: { intent: 'bright-red' } }, save: false };
      },
    });
    assert.equal(asked.options.customize, true, 'the modal was asked to customize');
    assert.equal(asked.options.editable, false, 'the name is settled, so no name field');
    assert.equal(asked.options.base.name, 'warm', 'the base is the active skin');

    assert.equal(customized.code, 'CUSTOMIZED');
    assert.equal(customized.skin.name, 'warm', 'the name did not move');
    assert.equal(readSkin('warm', { dir: folder })?.palette.intent, 'bright-red', 'the file was updated');
    assert.equal(readActiveName({ dir: folder }), 'warm', 'and it is still the project default');
    assert.equal(readSkin('bright-red', { dir: folder }), null, 'no new skin was created');

    // Cancelling leaves the file exactly as it was.
    const cancelled = await run('customize make it cooler', { skinSubchat: async () => null });
    assert.equal(cancelled.code, 'CANCELLED');
    assert.equal(readSkin('warm', { dir: folder })?.palette.intent, 'bright-red', 'the look is unchanged');
  } finally {
    resetTheme();
  }
});

test('/skins customize refuses without a request or without a subchat', async () => {
  const { folder, run } = makeCommand('customize-refuse');
  try {
    saveSkin({ name: 'warm', palette: { intent: 'bright-yellow' } }, { dir: folder });
    writeActiveName('warm', { dir: folder });

    const empty = await run('customize');
    assert.equal(empty.code, 'EMPTY_REQUEST');
    const noSubchat = await run('customize make it warmer');
    assert.equal(noSubchat.code, 'NO_SUBCHAT');
  } finally {
    resetTheme();
  }
});

test('/skins save puts the skin on and makes it the project default, so the UI changes at once', async () => {
  // The regression: `save` wrote the file and nothing else, so the project stayed on the
  // previous skin and the screen never repainted — "it saved but no colours changed".
  const { folder, run, applied } = makeCommand('save-selects');
  try {
    applySkin({ name: 'probe', palette: { user: 'red', intent: 'bright-magenta' } });
    const result = await run('save myown');
    assert.equal(result.code, 'SAVED');
    assert.equal(result.skin.name, 'myown');
    assert.equal(readSkin('myown', { dir: folder })?.palette.user, 'red', 'the look on screen was written down');
    assert.equal(readActiveName({ dir: folder }), 'myown', 'and the project now opens in it');
    assert.deepEqual(applied, ['myown'], 'the repaint hook fired, so the screen changes at once');
  } finally {
    resetTheme();
  }
});

test('/skins prompt always writes the applied skin, and only "apply and save" makes it the default', async () => {
  // The regression this fixes: "Apply for this session" used to write nothing at all, so
  // the session recorded a skin *name* with no file behind it — a resume had nothing to
  // put back, and the look was never linked to the conversation. A skin is a file; a look
  // that lives only in RAM cannot be re-read, listed or restored. `save` therefore decides
  // one narrower thing: whether the *project* adopts it as its default.
  const { folder, run } = makeCommand('prompt-save');
  try {
    const saved = await run('prompt warm it up', {
      skinSubchat: async () => ({ skin: { name: 'sunset', palette: { intent: 'bright-yellow' } }, save: true }),
    });
    assert.equal(saved.code, 'SAVED', 'the choice to save was honoured');
    assert.equal(saved.skin.name, 'sunset');
    assert.equal(activePalette().intent, 'bright-yellow', 'and the look is still on screen');
    assert.equal(readSkin('sunset', { dir: folder })?.palette.intent, 'bright-yellow', 'the file really exists');
    assert.equal(readActiveName({ dir: folder }), 'sunset', 'and the project remembers it');

    // "Apply for this session" writes the file too — that is what makes a resume possible —
    // but leaves the project's default where it was.
    const onlyApplied = await run('prompt a neon look', {
      skinSubchat: async () => ({ skin: { name: 'neon', palette: { intent: 'bright-magenta' } }, save: false }),
    });
    assert.equal(onlyApplied.code, 'PROPOSED');
    assert.equal(readSkin('neon', { dir: folder })?.palette.intent, 'bright-magenta', 'the file is written so a resume can find it');
    assert.equal(readActiveName({ dir: folder }), 'sunset', 'but the project default did not move');
    assert.equal(activePalette().intent, 'bright-magenta', 'and the look is on');
  } finally {
    resetTheme();
  }
});
