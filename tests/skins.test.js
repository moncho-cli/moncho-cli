import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  setPalette, setTokens, applySkin, resetTheme,
  activePalette, activeTokens, CONVERSATION_COLORS, SLASH_COLORS, colorizeLine, colorizeIntent,
} from '../app/theme.js';
import { BLESSED_COLORS, BLESSED_BACKGROUNDS, isColorName, isBackgroundColorName } from '../utils/color-names.js';
import { bandLine, bandColor, BAND_BACKGROUNDS } from '../app/prose-band.js';
import { selectedOpen } from '../app/slash-bar.js';
import { createLogger } from '../utils/logger.js';
import { registerLogger, clearLogger } from '../utils/host.js';
import { withTui } from './support/tui-harness.js';

/**
 * Skins (`docs/interface/skins`), the **live palette** half: the in-place mutation that
 * lets a skin repaint a running transcript and the prose bands that follow it.
 *
 * The store half lives in `tests/skins-store.test.js`, the paint sites in
 * `tests/skins-paint.test.js`, the command half in `tests/skins-command.test.js` and the
 * `/skins prompt` subchat in `tests/skins-prompt.test.js`. Everything here runs against a
 * throwaway directory under `agent/`, so no real skin is touched.
 */

const dir = `agent/skins-test-${process.pid}`;
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A fresh skins directory per case, so cases cannot see each other's files. */
function freshDir(name) {
  const target = `${dir}/${name}`;
  fs.rmSync(target, { recursive: true, force: true });
  return target;
}

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

test('a repaint records the live profile, so a band that did not move is diagnosable', async () => {
  // The screen can be silent about a refused band: the tag layer keeps the shipped colour,
  // so the row looks exactly as it did. The repaint line is the evidence that the repaint
  // ran at all, and it carries the profile now in force — which is how "applied but nothing
  // changed" is told apart from "the command never ran".
  const folder = freshDir('repaint-log');
  const file = `${folder}/moncho.log`;
  const logger = createLogger({ file, level: 'info' });
  registerLogger(logger);
  try {
    await withTui(async (tui) => {
      resetTheme();
      tui.log('You:');
      await new Promise((resolve) => setImmediate(resolve));

      tui.repaintTheme();
      let text = fs.readFileSync(file, 'utf-8');
      assert.match(text, /theme repainted/, 'the repaint itself is recorded');
      assert.match(text, /"transcript":true/, 'with the proof the transcript was repainted');
      assert.match(text, /"userBg":"blue"/, 'and the band now in force');

      setTokens({ userBg: 'green' });
      tui.repaintTheme();
      text = fs.readFileSync(file, 'utf-8');
      assert.match(text, /"userBg":"green"/, 'a moved band is recorded in the next line');
      assert.equal(bandColor('user'), 'green', 'and the band really moved');
    });
  } finally {
    clearLogger();
    resetTheme();
  }
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

test('a skin moves the prose band backgrounds, and the band follows the live palette', async () => {
  // The reported bug: every request in the log asked for a *background* ("user messages to
  // be green background", "the model prose in blue background"), there was no band key, so
  // the model moved the nearest foreground, reported success, and the band stayed exactly
  // as it was. The bands are live theme state now (`app/theme-palette.js#PROSE_BACKGROUNDS`)
  // and `setTokens()`/`applySkin()` move them in place, so the next paint wears them.
  assert.equal(bandColor('user'), 'blue');
  assert.equal(bandColor('assistant'), 'red');
  assert.equal(bandLine('hi', 'user', 4), '{blue-bg}hi  {/blue-bg}');

  try {
    setTokens({ userBg: 'green', assistantBg: 'blue' });
    assert.equal(BAND_BACKGROUNDS.user, 'green', 'the live object was mutated, not replaced');
    assert.equal(bandColor('assistant'), 'blue');
    assert.equal(bandLine('hi', 'user', 4), '{green-bg}hi  {/green-bg}', 'the band follows the skin');

    applySkin({ name: 'bg', palette: {}, userBg: 'magenta', assistantBg: 'blue' });
    assert.equal(bandLine('x', 'user', 3), '{magenta-bg}x  {/magenta-bg}', 'applySkin() moves it too');
    assert.equal(activeTokens().userBg, 'magenta', 'the read side the command persists carries it');

    // An unpaintable name is refused by the tag layer, never printed literally.
    setTokens({ userBg: 'orange' });
    assert.equal(bandColor('user'), 'magenta', 'a colour the terminal cannot paint is ignored');

    // And the rows already on screen really repaint in the new band.
    await withTui(async (tui) => {
      tui.logProse('user', 'a prompt before the skin');
      tui.logProse('assistant', 'prose before the skin');
      await new Promise((resolve) => setImmediate(resolve));
      const frame = () => tui.transcript.getContent();
      assert.match(frame(), /\x1b\[45m/, 'the user band is magenta before it is moved');

      setTokens({ userBg: 'green', assistantBg: 'blue' });
      tui.repaintTheme();
      await new Promise((resolve) => setImmediate(resolve));

      assert.match(frame(), /\x1b\[42m/, 'the same user row is on a green band after the skin');
      assert.match(frame(), /\x1b\[44m/, 'and the model prose on a blue one');
      assert.doesNotMatch(frame(), /\x1b\[45m/, 'the old magenta band is gone');
      assert.match(frame().replace(/\x1b\[[\d;]*m/g, ''), /a prompt before the skin/, 'the glyphs are unchanged');
    });
  } finally {
    resetTheme();
  }
  assert.equal(bandColor('user'), 'blue', 'resetTheme() puts the shipped bands back');
  assert.equal(bandColor('assistant'), 'red');
});

test('a bright or light name paints as a background too, so a background token takes it', () => {
  // The correction: the skins module refused a bright background on the claim that blessed
  // had no bright or light background case at all, so `/skins warm userBg=bright-blue` was
  // a `BAD_VALUE` and the band never moved. Blessed *does* paint one: the tag parser
  // rewrites every `-` of a tag to a space (`lib/widgets/element.js#_parseTags`), so
  // `{bright-blue-bg}` reaches `_attr()` as `bright blue bg` — the spelling the switch has
  // a case for (`lib/program.js#_attr`, `\x1b[104m`). `tests/skins-colors.test.js` proves
  // it through a real widget.
  assert.equal(isColorName('bright-blue'), true, 'it is a foreground name');
  assert.equal(isBackgroundColorName('bright-blue'), true, 'and a background one as well');
  assert.equal(isBackgroundColorName('light-green'), true, 'and so is a light shade');
  assert.equal(isBackgroundColorName('blue'), true, 'and the eight base backgrounds');
  assert.equal(BLESSED_BACKGROUNDS.length, BLESSED_COLORS.length, 'the two vocabularies hold the same names');

  try {
    // The band layer takes the bright name and writes the tag that really paints.
    setTokens({ userBg: 'bright-blue' });
    assert.equal(bandColor('user'), 'bright-blue', 'the band moves to the name that was asked for');
    assert.equal(bandLine('hi', 'user', 4), '{bright-blue-bg}hi  {/bright-blue-bg}');

    // The slash-popup selection band is a background too, so it takes the same name.
    setTokens({ selected: 'bright-blue', selectedFg: 'black' });
    assert.equal(SLASH_COLORS.selected, 'bright-blue', 'the selection band takes it as well');
    assert.match(selectedOpen(), /\{bright-blue-bg\}/);
  } finally {
    resetTheme();
  }
});

