import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BLESSED_COLORS, BLESSED_BACKGROUNDS, isColorName, isBackgroundColorName,
} from '../utils/color-names.js';
import { bgTag } from '../app/paint-tags.js';
import {
  setTerminalColorCount, terminalColorCount, supportsBrightColors,
  effectiveBackgroundName, reducedBackgrounds,
} from '../app/terminal-capability.js';
import { fakeTty } from './support/tui-harness.js';
import blessed from 'neo-blessed';

/**
 * The colour vocabulary of a skin (`docs/interface/skins`), proved against the **real**
 * library rather than against a hand-written list.
 *
 * This suite exists because the skins module spent hours on a false premise: that blessed
 * had no bright or light *background*, so `{bright-blue-bg}` would be printed literally on
 * the row. It does have one — the tag parser rewrites every `-` of a tag to a space before
 * it asks for the escape (`lib/widgets/element.js#_parseTags`), so `{bright-blue-bg}` reaches
 * `_attr()` as `bright blue bg`, and the switch has a case for exactly that
 * (`lib/program.js#_attr`, `\x1b[104m`).
 *
 * The mistake is invisible from the source alone, because asking `_attr()` for the
 * **hyphenated** `bright-blue bg` really does answer `null`. So every claim here is made
 * against a **real widget on a real screen**, and the assertion is on the bytes that reach
 * the screen.
 */

/** Paint one tag through a real widget and return the escape that reached the screen. */
async function paintBackground(name, { term = 'xterm-256color' } = {}) {
  const previous = process.env.TERM;
  process.env.TERM = term;
  const input = fakeTty();
  const output = fakeTty();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk.toString()));
  const screen = blessed.screen({ input, output, smartCSR: false, fullUnicode: true });
  try {
    blessed.box({
      parent: screen, top: 0, left: 0, width: 20, height: 1, tags: true,
      content: `{${name}-bg}X{/${name}-bg}`,
    });
    screen.render();
    await new Promise((resolve) => setImmediate(resolve));
    const frame = chunks.join('');
    const codes = [...frame.matchAll(/\x1b\[(\d+)m/g)].map((match) => Number(match[1]));
    return {
      frame,
      codes,
      background: codes.find((c) => (c >= 40 && c <= 47) || (c >= 100 && c <= 107)) ?? null,
      literal: /\{[a-z-]+-bg\}/.test(frame),
    };
  } finally {
    screen.destroy();
    input.destroy();
    output.destroy();
    process.env.TERM = previous;
  }
}

test('every blessed colour name resolves as a background, through a real widget', async () => {
  // The regression this pins: a bright or light name was refused as a background on the
  // claim that blessed could not paint one, so `/skins warm userBg=bright-blue` was a
  // `BAD_VALUE` and the band never moved. Each name below is painted through a real
  // blessed widget and the escape is read back off the screen.
  //
  // The names that resolve to the terminal's **own** background are the grey family and
  // the black ones: blessed spells `grey bg` as `\x1b[100m`, and its own render path reads
  // that escape as "default foreground and background" (`screen.js#attrCode`, `case 100`),
  // so the band is not filled. They are not refused — the request is honoured and the
  // diagnostics say what the terminal will show (`app/terminal-capability.js`) — but they
  // are not a fill either, and the test says so.
  const fillsWithNothing = new Set(['grey', 'gray', 'light-black', 'bright-black', 'default']);
  for (const name of BLESSED_COLORS) {
    const painted = await paintBackground(name);
    assert.equal(painted.literal, false, `${name} must not print its tag literally`);
    if (fillsWithNothing.has(name)) {
      assert.equal(painted.background, null, `${name} resolves to the terminal's own background`);
    } else {
      assert.notEqual(painted.background, null, `${name} must paint a background`);
    }
  }
});

test('a bright background is the bright escape, not the base one', async () => {
  // The distinction the false premise hid: `{bright-blue-bg}` is `\x1b[104m` and
  // `{blue-bg}` is `\x1b[44m`. They are different cells, and a skin that asks for the
  // bright one gets it.
  const bright = await paintBackground('bright-blue');
  const base = await paintBackground('blue');
  assert.equal(bright.background, 104, 'the bright blue background');
  assert.equal(base.background, 44, 'and the base blue background');
  assert.notEqual(bright.background, base.background, 'they are not the same colour');
});

test('the background vocabulary is the same set as the foreground one', () => {
  // The two doors are kept apart because a background is a different question — but they
  // hold the same names, because blessed paints a bright background as well as a bright
  // foreground. A smaller list here is what cost the skins module its bright bands.
  assert.deepEqual([...BLESSED_BACKGROUNDS].sort(), [...BLESSED_COLORS].sort());
  assert.equal(BLESSED_BACKGROUNDS.length, BLESSED_COLORS.length);
  for (const name of BLESSED_COLORS) {
    assert.equal(isBackgroundColorName(name), true, `${name} paints as a background`);
    assert.equal(isColorName(name), true, `${name} paints as a foreground`);
  }
});

test('the tag layer builds a background tag for a bright name', () => {
  // The one place a colour becomes a `-bg` tag: a bright name must survive it, or the
  // band is painted in the shipped colour and the user is told nothing.
  assert.equal(bgTag('bright-blue', 'hi'), '{bright-blue-bg}hi{/bright-blue-bg}');
  assert.equal(bgTag('light-green', 'hi'), '{light-green-bg}hi{/light-green-bg}');
  assert.equal(bgTag('blue', 'hi'), '{blue-bg}hi{/blue-bg}');
  // A name blessed does not know is still refused, so a literal tag can never reach the
  // screen — the rule the smaller vocabulary was built to serve, now on the right door.
  assert.equal(bgTag('orange', 'hi'), 'hi', 'an unknown name paints nothing');
  assert.equal(bgTag('default', 'hi'), 'hi', 'the default background is the absence of one');
});

test('the terminal capability says what the screen will really show', () => {
  // The honest fallback: a bright background is honoured, and a terminal that cannot show
  // the bright form paints the base colour. The diagnostics name both, so "the band did
  // not move" is answerable.
  try {
    setTerminalColorCount(256);
    assert.equal(terminalColorCount(), 256, 'the count is recorded');
    assert.equal(supportsBrightColors(), true, 'and sixteen colours are enough for the bright form');
    assert.equal(effectiveBackgroundName('bright-blue'), 'bright-blue', 'the bright form survives');

    setTerminalColorCount(8);
    assert.equal(supportsBrightColors(), false, 'eight colours are not');
    assert.equal(effectiveBackgroundName('bright-blue'), 'blue', 'the bright blue becomes the base blue');
    assert.equal(effectiveBackgroundName('light-green'), 'green', 'and so does a light green');
    assert.equal(effectiveBackgroundName('blue'), 'blue', 'a base colour is unchanged');

    // The grey family resolves to the terminal's own background at every capability:
    // blessed spells `grey bg` as `\x1b[100m`, which its render path reads as "default".
    setTerminalColorCount(256);
    assert.equal(effectiveBackgroundName('grey'), 'default', 'the grey family is the terminal default');
    assert.equal(effectiveBackgroundName('bright-black'), 'default', 'and so are the black ones');
    // The light grey spellings are the white background in blessed's spelling.
    assert.equal(effectiveBackgroundName('light-grey'), 'light-grey', 'the light grey stays the white background');

    // An unknown terminal is not evidence against the bright form.
    setTerminalColorCount(null);
    assert.equal(terminalColorCount(), null, 'the count is unknown');
    assert.equal(supportsBrightColors(), true, 'and the bright form is not ruled out');
    assert.equal(effectiveBackgroundName('bright-blue'), 'bright-blue', 'so the name is kept');

    // The reduced set names every band whose form the terminal will not show.
    const reduced = reducedBackgrounds({ userBg: 'bright-blue', assistantBg: 'red' }, ['userBg', 'assistantBg'], 8);
    assert.deepEqual(reduced, { userBg: { requested: 'bright-blue', effective: 'blue' } },
      'only the band that changes is named');
  } finally {
    setTerminalColorCount(null);
  }
});
