import test from 'node:test';
import assert from 'node:assert/strict';

import { setPalette, setTokens, resetTheme } from '../app/theme.js';
import { SLASH_COLORS, colorizeLine } from '../app/theme.js';
import { selectedOpen, selectedClose } from '../app/slash-bar.js';
import {
  resolveTags, fgTag, hasSymbolicTags, stripSymbolicTags, symbolicTag, FALLBACK_COLOR,
} from '../app/paint-tags.js';
import { renderTranscriptLines } from '../app/tui-render.js';
import { formatNoticeRow } from '../app/notice-overlay.js';
import { createInputHint } from '../app/input-hint.js';

/**
 * Skins (`docs/interface/skins`), the **paint sites** half: the places that read a colour
 * at paint time, so a skin moved on the live palette reaches the screen.
 *
 * The live-palette mutation itself is proved in `tests/skins.test.js`, the store in
 * `tests/skins-store.test.js` and the prose bands in `tests/skins.test.js`.
 */

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
