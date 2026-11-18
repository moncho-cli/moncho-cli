import pkg from '../package.json' with { type: 'json' };

/**
 * The brand line (`docs/interface/brand-line`): the one row of text that names the
 * program, right-aligned on the **very first row of the screen**.
 *
 * This **supersedes** the original backlog item, which asked for `moncho.png` to be
 * shown as a fixed-position image, colours inverted, capped at 200x200 px. That is
 * not achievable in this front end, and the reason is a property of the toolkit
 * rather than of the code:
 *
 *  - neo-blessed addresses a **character cell**, and `lib/colors.js#hexToRGB` maps
 *    every colour onto the nearest xterm-256 index, so there is no per-pixel colour
 *    and no alpha to composite with. A real raster image needs an out-of-band
 *    protocol (kitty graphics, sixel, iTerm2 inline) that blessed does not speak;
 *  - a half-block rendering of the artwork is what the code did instead, and at the
 *    size the region allows it degenerates into a ~24x24 stencil — a glyph mosaic,
 *    not the drawing.
 *
 * So: **no image** (the author's decision: show the real thing or show nothing), and
 * a line of text instead, which is what a character-cell front end renders
 * *faithfully*. It is `MONCHO (v <version>)` — the version being the one
 * `package.json` declares, so there is a single source of truth.
 *
 * Pure and terminal-free: no `fs`, no screen, so the formatting and the fit rule are
 * unit tested without a pty.
 */

/** The program's name, as it is painted. */
export const BRAND_NAME = 'MONCHO';

/** The version `package.json` declares, or a visible `0.0.0` if it is ever missing. */
export const BRAND_VERSION = (() => {
  const raw = typeof pkg?.version === 'string' ? pkg.version.trim() : '';
  return raw || '0.0.0';
})();

/**
 * The blessed colour of the brand line: the brightest white there is, so the mark
 * reads as a mark on a dark terminal without shouting over the conversation.
 *
 * It is applied as the box's **`style.fg`**, never as an inline `{colour-fg}` tag,
 * and that is not a style preference: neo-blessed counts the tag's own bytes towards
 * the cell width, so a box sized to the visible line loses its last characters
 * (`MONCHO (v      ` instead of `MONCHO (v 1.0.0)`). A style attribute has no such
 * problem, because there is nothing in the content to count.
 */
export const BRAND_COLOR = 'bright-white';

/**
 * Where the line sits: row **0**, the very first row of the screen, one column in
 * from the right edge — the same right edge the status bar's meter and the notices
 * end on, so the three line up.
 *
 * Row 0 is not free by accident: `app/tui-layout.js#setBrandRows` displaces the whole
 * conversation one row down (the transcript's `top` becomes the brand's height), so
 * the conversation's border *is* the row below the mark.
 */
export const BRAND_TOP = 0;
export const BRAND_RIGHT = 1;

/**
 * The line itself: `MONCHO (v 1.0.0)`. A blank or missing version falls back to the
 * declared one rather than painting `MONCHO (v )`.
 */
export function formatBrand(version = BRAND_VERSION) {
  const value = String(version ?? '').trim() || BRAND_VERSION;
  return `${BRAND_NAME} (v ${value})`;
}

/**
 * The size the brand line needs in an `width` by `height` region of terminal cells,
 * or `null` when the region cannot hold it.
 *
 * It is one row however wide the terminal is, and it is **all or nothing**: the line
 * is a mark, not prose, so a narrow window hides it rather than clipping or wrapping
 * it, and the row it would have used goes back to the conversation. This is the
 * honest successor of the "if the window is small" clause of the original item —
 * the same rule, one line instead of a square.
 */
export function resolveBrandSize({ width = 0, height = 0, line = '' } = {}) {
  const text = String(line ?? '');
  const columns = Math.max(0, Math.trunc(Number(width) || 0));
  const rows = Math.max(0, Math.trunc(Number(height) || 0));
  if (!text) return null;
  if (columns < text.length) return null;
  if (rows < 1) return null;
  return { cols: text.length, rows: 1 };
}
