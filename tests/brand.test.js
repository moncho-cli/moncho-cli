import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRAND_COLOR,
  BRAND_NAME,
  BRAND_RIGHT,
  BRAND_TOP,
  BRAND_VERSION,
  formatBrand,
  resolveBrandSize,
} from '../app/brand.js';
import { createBrandBar } from '../app/brand-bar.js';
import { withTui, visible, plainText } from './support/tui-harness.js';

/**
 * The brand line (`docs/interface/brand-line`): `MONCHO (v x.y.z)`, right-aligned on
 * the very first row of the screen, with the conversation displaced one row below it.
 *
 * This is what replaced the attempt to paint `moncho.png` as an image: a character
 * cell carries one colour and no alpha, so a raster logo cannot be composited into
 * the conversation, and the half-block fallback degenerated into a glyph mosaic. The
 * pure formatter and the fit rule are proved here without a screen; the last two
 * cases drive the real TUI.
 */

test('formatBrand() names the program and the version the manifest declares', () => {
  assert.equal(BRAND_NAME, 'MONCHO');
  assert.match(BRAND_VERSION, /^\d+\.\d+\.\d+/, 'the version comes from package.json');
  assert.equal(formatBrand(), `MONCHO (v ${BRAND_VERSION})`);
  assert.equal(formatBrand('2.5.1'), 'MONCHO (v 2.5.1)');

  // A blank or missing version never paints `MONCHO (v )`: the declared one wins.
  assert.equal(formatBrand(''), `MONCHO (v ${BRAND_VERSION})`);
  assert.equal(formatBrand('   '), `MONCHO (v ${BRAND_VERSION})`);
  assert.equal(formatBrand(null), `MONCHO (v ${BRAND_VERSION})`);
  assert.equal(formatBrand(undefined), `MONCHO (v ${BRAND_VERSION})`);
  assert.equal(formatBrand(' 3.0.0 '), 'MONCHO (v 3.0.0)');
});

test('resolveBrandSize() holds one row, and hides the line that cannot fit whole', () => {
  const line = formatBrand();

  // Roomy: exactly one row, as wide as the line itself.
  const size = resolveBrandSize({ width: 76, height: 17, line });
  assert.deepEqual(size, { cols: line.length, rows: 1 });

  // It is a mark, not prose: a region one column too narrow hides it rather than
  // wrapping or clipping it -- and a hidden line displaces no row at all.
  assert.equal(resolveBrandSize({ width: line.length, height: 1, line })?.cols, line.length);
  assert.equal(resolveBrandSize({ width: line.length - 1, height: 17, line }), null);
  assert.equal(resolveBrandSize({ width: 200, height: 0, line }), null, 'no rows on screen');
  assert.equal(resolveBrandSize({ width: 200, height: 17, line: '' }), null, 'nothing to draw');
  assert.equal(resolveBrandSize({}), null);
  assert.equal(resolveBrandSize({ width: Number.NaN, height: -5, line }), null);

  // A wider window never changes the height: the mark is one row, always.
  for (const width of [line.length, 40, 120, 400]) {
    assert.equal(resolveBrandSize({ width, height: 50, line }).rows, 1);
  }
});

test('createBrandBar() paints one row, displaces it, and gives it back', () => {
  const bands = [];
  const bar = createBrandBar({
    region: () => ({ width: 200, height: 40 }),
    reserve: (n) => bands.push(n),
  });

  assert.equal(bar.line, formatBrand());
  assert.equal(bar.color, BRAND_COLOR);
  assert.deepEqual(bar.size, { cols: formatBrand().length, rows: 1 });
  assert.equal(bar.visible, 1);
  assert.equal(bar.band, 1, 'one row is taken from the top for the mark');
  assert.equal(bands.at(-1), 1);
  assert.equal(bar.widget, null, 'no screen, no widget: still a working model');

  // Repainting is idempotent: the displacement does not creep.
  bar.paint();
  assert.equal(bar.band, 1);
  assert.equal(bands.at(-1), 1);

  // A region too narrow hides the mark *and* puts the conversation back at the top.
  const narrow = createBrandBar({
    line: formatBrand(),
    region: () => ({ width: 3, height: 40 }),
    reserve: (n) => bands.push(n),
  });
  assert.equal(narrow.size, null);
  assert.equal(narrow.visible, 0);
  assert.equal(narrow.band, 0);
  assert.equal(bands.at(-1), 0, 'the row goes back to the conversation');

  bar.close();
  assert.equal(bar.band, 0);
  assert.equal(bands.at(-1), 0);
  assert.equal(bar.visible, 0);
});

test('a pty puts the brand line on row 0 and starts the conversation below it', async () => {
  await withTui(async (tui, { painted, output }) => {
    const size = tui.brandSize;
    assert.ok(size, 'the screen has room for the mark');
    assert.equal(size.rows, 1, 'the mark is one row tall');
    assert.equal(tui.brandLine, formatBrand());
    assert.match(tui.brandLine, /^MONCHO \(v \d+\.\d+\.\d+\)$/);

    // The very first row of the screen, and the conversation displaced below it.
    assert.equal(BRAND_TOP, 0);
    assert.equal(tui.brandBar.widget.lpos.yi, 0, 'row 0: the first line of the screen');
    assert.equal(tui.transcript.top, 1, 'the conversation edge is one line below');
    assert.equal(tui.transcript.lpos.yi, 1, 'its border is the row after the mark');
    assert.equal(tui.brandBar.band, 1);

    // Right-aligned against the same edge the status meter ends on.
    assert.equal(tui.brandBar.widget.lpos.xl, output.columns - BRAND_RIGHT);

    // The whole line is on screen -- the version is not clipped -- and the first
    // conversation line lands below the mark's row.
    tui.log('first line of the conversation');
    await new Promise((resolve) => setImmediate(resolve));
    const frame = plainText(painted());
    assert.match(frame, /MONCHO \(v \d+\.\d+\.\d+\)/, 'the version survives the cell width');
    assert.match(visible(tui), /first line of the conversation/);
  });
});

test('the brand line follows a resize and is hidden when the window cannot hold it', async () => {
  await withTui(async (tui, { output }) => {
    assert.ok(tui.brandSize);
    assert.equal(tui.transcript.top, 1);

    // A narrower window than the line: the mark is hidden and the row goes back.
    output.columns = 8;
    output.rows = 24;
    output.emit('resize');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(tui.brandSize, null, 'eight columns cannot hold the line');
    assert.equal(tui.brandBar.band, 0);
    assert.equal(tui.transcript.top, 0, 'the conversation gets the top edge back');
    assert.equal(tui.brandBar.widget.hidden, true);

    // Back to a roomy window: it returns, still one row, conversation below it.
    output.columns = 80;
    output.rows = 24;
    output.emit('resize');
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(tui.brandSize);
    assert.equal(tui.brandSize.rows, 1);
    assert.equal(tui.transcript.top, 1);
    assert.equal(tui.brandBar.widget.hidden, false);
    assert.equal(tui.brandBar.widget.lpos.xl, 80 - BRAND_RIGHT);
  });
});