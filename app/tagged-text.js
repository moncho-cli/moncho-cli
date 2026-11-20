import { displayWidth } from './cell-width.js';

/**
 * Measuring and padding a line that already carries neo-blessed tags.
 *
 * Two views need the same answer — "how many terminal cells does this tagged line
 * really cover?" — and neither may count the tags themselves:
 *
 *  - a prose band is padded so its background reaches the region's right edge, and
 *  - a markdown table pads each cell so its column separators line up.
 *
 * Counting the tag bytes instead of the glyphs is what would leave a band a dozen
 * cells short and a table's pipes ragged, so the rule lives in one place. The unit is
 * the display cell (`app/cell-width.js`), so a wide glyph (an emoji, a CJK character)
 * is charged the two columns a terminal paints it in.
 *
 * `untag()` restores the two literals `escapeTags()` protects: a real `{` in model
 * output reaches the renderer as the `{open}` tag, and it is one cell wide again.
 */

const TAG_RE = /\{[^}]*\}/g;

/** The visible glyphs of a tagged line (`{open}`/`{close}` become `{`/`}`). */
export function untag(line) {
  return String(line ?? '')
    .replace(/\{open\}/g, '{')
    .replace(/\{close\}/g, '}')
    .replace(TAG_RE, '');
}

/** How many terminal cells a tagged line covers, tags not counted. */
export function visibleWidth(line) {
  return displayWidth(untag(line));
}

/**
 * Pad a tagged line to `width` cells: the extra space goes on the side `align`
 * names (left by default, so a cell's text starts on its column and the padding
 * trails). A line already at or past the width comes back byte-for-byte — a banded
 * line too long for the region is left for blessed to wrap rather than cut, and a
 * cell wider than its column is never truncated under its neighbours.
 */
export function padVisible(line, width, align = 'left') {
  const text = String(line ?? '');
  const target = Math.max(0, Math.trunc(Number(width)) || 0);
  const gap = target - visibleWidth(text);
  if (gap <= 0) return text;
  if (align === 'right') return `${' '.repeat(gap)}${text}`;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return `${' '.repeat(left)}${text}${' '.repeat(gap - left)}`;
  }
  return `${text}${' '.repeat(gap)}`;
}
