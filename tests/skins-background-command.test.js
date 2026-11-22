import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { withTui } from './support/tui-harness.js';
import { skinsCommand } from '../app/skins-command.js';
import { rememberAppliedSkin } from '../app/skin-host.js';
import { resetTheme, activeTokens } from '../app/theme.js';
import { readSkin } from '../utils/skins-store.js';
import { createLogger } from '../utils/logger.js';
import { registerLogger, clearLogger } from '../utils/host.js';

/**
 * `/skins` and the **background** bands (`docs/interface/skins`), on the command path.
 *
 * These are the cases that were in `tests/skins-command.test.js`: the band half of the
 * command belongs with the bands, not with the command's grammar, and the file they left
 * behind was over its line budget.
 *
 * The correction these cases carry is the one the whole item turned on: a bright
 * background was refused as a `BAD_VALUE` on the false claim that blessed could not paint
 * one, so the band never moved. It can (`tests/skins-colors.test.js` proves it through a
 * real widget), so the command takes the name and the band follows.
 */

/** A command bound to one throwaway directory. */
function makeCommand(dir) {
  const cmd = skinsCommand();
  return (arg, extra = {}) => cmd.run({ arg, skinsDir: dir, ...extra });
}

test('/skins accepts the two prose band tokens, so a background request reaches the screen', async () => {
  // There used to be no token to name: `/skins warm userBg=green` was BAD_VALUE, so a user
  // asking for a background had no way to get one and the model had no key to answer with.
  const dir = 'agent/probe-skins-background';
  fs.rmSync(dir, { recursive: true, force: true });
  const run = makeCommand(dir);
  try {
    resetTheme();
    const result = await run('probe userBg=green assistantBg=blue save probe');
    assert.equal(result.ok, true);
    assert.equal(result.code, 'SAVED');
    assert.equal(activeTokens().userBg, 'green', 'the user band moved');
    assert.equal(activeTokens().assistantBg, 'blue', 'and so did the model band');

    const onDisk = readSkin('probe', { dir });
    assert.equal(onDisk.userBg, 'green', 'and the band is written down with the skin');
    assert.equal(onDisk.assistantBg, 'blue');

    // A colour blessed cannot paint is refused by name, exactly like a foreground.
    const bad = await run('probe userBg=orange');
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'BAD_VALUE');
    assert.match(bad.message, /orange/);
  } finally {
    resetTheme();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/skins takes a bright background, and refuses only a colour blessed cannot paint', async () => {
  // The correction, on the command path: the command used to refuse `userBg=bright-blue`
  // because blessed was believed to have no bright background case, so the band never
  // moved. It does paint one (proved in `tests/skins-colors.test.js` through a real
  // widget), so the command takes the name and the band follows.
  const dir = 'agent/probe-skins-background';
  fs.rmSync(dir, { recursive: true, force: true });
  const run = makeCommand(dir);
  const file = `${dir}/moncho.log`;
  const logger = createLogger({ file, level: 'info' });
  registerLogger(logger);
  try {
    resetTheme();
    const good = await run('probe userBg=bright-blue');
    assert.equal(good.ok, true, 'the bright background is accepted');
    assert.equal(activeTokens().userBg, 'bright-blue', 'and the band really moves to it');

    // A name blessed does not know is still refused, by name: the tag would be printed
    // literally on the row, which is the symptom the refusal exists for.
    const bad = await run('probe userBg=orange');
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'BAD_VALUE');
    assert.match(bad.message, /orange/, 'the refusal names the value');
    assert.match(bad.message, /as a background/, 'and says the mistake is the background');
    assert.equal(activeTokens().userBg, 'bright-blue', 'the band in force is untouched');

    const text = fs.readFileSync(file, 'utf-8');
    assert.match(text, /background colour refused/, 'the log answers "why did the band not move"');
    assert.match(text, /"value":"orange"/, 'and names the value it refused');
  } finally {
    clearLogger();
    resetTheme();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a bright background reaches the real screen cells, through the real command', async () => {
  // The correction, end to end: the bright background used to be refused as a `BAD_VALUE`
  // on the false claim that blessed could not paint one, so the band never moved. The
  // assertion is on the **cells**: the frame carries the bright background escape
  // (`\x1b[104m` for a bright blue), not the base one and not a literal tag.
  const dir = 'agent/probe-skins-background';
  fs.rmSync(dir, { recursive: true, force: true });
  await withTui(async (tui) => {
    const run = makeCommand(dir);
    const onApply = (skin) => rememberAppliedSkin(skin, { repaint: () => tui.repaintTheme() });

    try {
      resetTheme();
      tui.logProse('user', 'a prompt before the skin');
      await new Promise((resolve) => setImmediate(resolve));
      assert.match(tui.transcript.getContent(), /\x1b\[44m/, 'the user row starts on the shipped blue band');

      const result = await run('reader userBg=bright-blue save reader', { onApply });
      assert.equal(result.ok, true, 'the bright background is accepted');
      await new Promise((resolve) => setImmediate(resolve));

      const frame = tui.transcript.getContent();
      assert.match(frame, /\x1b\[104m/, 'the row wears the bright blue background');
      assert.doesNotMatch(frame, /\x1b\[44m/, 'and the base blue band is gone');
      assert.doesNotMatch(frame, /bright-blue-bg/, 'no literal tag reached the screen');
    } finally {
      resetTheme();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('the real /skins command repaints a live transcript, bands included, exactly as the loop wires it', async () => {
  // The faithful end-to-end case: a real screen, the real command, and the very `onApply`
  // hook the session loop passes (`rememberAppliedSkin` with `tui.repaintTheme` as the
  // repaint). It is the whole reported path — a background request, through the command, to
  // the cells on screen — and it fails the way the user saw if any link breaks.
  const dir = 'agent/probe-skins-background';
  fs.rmSync(dir, { recursive: true, force: true });
  await withTui(async (tui) => {
    const run = makeCommand(dir);
    const onApply = (skin) => rememberAppliedSkin(skin, { repaint: () => tui.repaintTheme() });

    try {
      resetTheme();
      tui.logProse('user', 'a prompt before the skin');
      tui.logProse('assistant', 'prose before the skin');
      await new Promise((resolve) => setImmediate(resolve));

      const frame = () => tui.transcript.getContent();
      assert.match(frame(), /\x1b\[44m/, 'the user row starts on the shipped blue band');
      assert.match(frame(), /\x1b\[41m/, 'and the prose on the shipped red one');

      const result = await run('reader userBg=green assistantBg=blue save reader', { onApply });
      assert.equal(result.ok, true);
      await new Promise((resolve) => setImmediate(resolve));

      // The row that was already on screen now wears the requested background.
      assert.match(frame(), /\x1b\[42m/, 'the same user row is on a green band after the command');
      assert.match(frame(), /\x1b\[44m/, 'and the prose on a blue one');
      assert.doesNotMatch(frame(), /\x1b\[41m/, 'the old red prose band is gone');
      assert.match(frame().replace(/\x1b\[[\d;]*m/g, ''), /a prompt before the skin/, 'the glyphs are unchanged');
    } finally {
      resetTheme();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('applying a skin records the live profile — the bands included — in the operational log', async () => {
  // A look that "saved but did not change" has to be diagnosable from the log alone, so the
  // command records what is now *in force*, not only the skin's name. The two bands are the
  // ones the reported bug was about, so they are asserted by name.
  const dir = 'agent/probe-skins-background';
  fs.rmSync(dir, { recursive: true, force: true });
  const run = makeCommand(dir);
  const file = `${dir}/moncho.log`;
  const logger = createLogger({ file, level: 'info' });
  registerLogger(logger);
  try {
    resetTheme();
    const result = await run('probe user=green userBg=green save probe');
    assert.equal(result.ok, true);
    const text = fs.readFileSync(file, 'utf-8');
    assert.match(text, /applied the skin "probe"/, 'the apply is recorded');
    assert.match(text, /saved the look on screen/, 'and so is the write');
    assert.match(text, /"userBg":"green"/, 'the live user band is in the line');
    assert.match(text, /"assistantBg":"red"/, 'and the band the request did not touch');
  } finally {
    clearLogger();
    resetTheme();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
