/**
 * How much room a string really takes on screen, counted in terminal **cells**.
 *
 * One pure rule used by everything that has to fit text into a box: the queue rows
 * (`app/queue-rows.js`), the caret of the prompt editor (`app/prompt-editor.js`,
 * `app/prompt-caret.js`) and the truncations that must not cut a character in half.
 * It lives on its own because a *queue* row and a *prompt* caret have nothing else in
 * common.
 *
 * Counting in cells rather than characters is the whole point: a CJK glyph paints two
 * cells of a one-character string, and a combining accent paints none. Counting the
 * wrong way is what pushes a row out of its box or lands the caret a column off.
 *
 * The unit is the **grapheme cluster**, not the code point, which is what makes an
 * emoji come out right: `❤️` is two code points and one glyph a terminal paints two
 * cells wide, `👍🏽` is three, `👨‍👩‍👧` five, and `e` plus a combining accent is two code
 * points in a single one-cell glyph. A cluster is charged **two** cells when any of its
 * code points is wide or pictographic, **zero** when it is entirely made of combining
 * marks, and **one** otherwise.
 *
 * The wide direction is deliberate: neo-blessed wraps a line by counting code units
 * and compensating for surrogate pairs (`lib/widgets/element.js#_wrapContent`), so an
 * astral emoji costs it two — the same two this rule charges. Over-counting the rare
 * BMP pictographic (a `☀`, which blessed counts as one) simply truncates a fitted
 * preview one glyph early, while under-counting would let a row wrap — and a wrapped
 * row is the one that gets clipped and loses its tail with no `…` at all (see
 * `docs/interface/message-queue`).
 */

/** Cells a fitted line may use when its caller knows no width (a first paint, the line CLI). */
export const DEFAULT_MAX_CELLS = 48;

/**
 * Code points a terminal paints in one cell that still occupy **two**: the CJK,
 * Hangul and fullwidth ranges neo-blessed itself counts as double-wide
 * (`lib/unicode.js#charWidth`).
 */
const WIDE_CELL_RE = /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u3000]/;

/** The pictographic code points: the emoji proper, astral or not (Unicode property). */
const PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;

/** An enclosing keycap, which makes a `1️⃣` two cells wide instead of one. */
const KEYCAP_RE = /\u20e3/;

/**
 * Code points that paint in **no** cell of their own: combining marks, the variation
 * selectors that turn a text glyph into its emoji presentation (`❤` + U+FE0F), the
 * zero-width joiner that glues a sequence together, and the skin-tone modifiers.
 * Missing these is how a combining accent steals a column it does not use.
 */
const ZERO_CELL_RE = /[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc\u200b-\u200f\u20d0-\u20ef\u302a-\u302f\ufe00-\ufe0f\ufeff]|\p{Emoji_Modifier}/u;

let graphemeSegmenter = null;

/**
 * The grapheme clusters of `text`, in order: the unit every width below is counted
 * in. `Intl.Segmenter` does the work when the runtime has it (Node 16+ does) and a
 * per-code-point split is the fallback, so the counting never throws on an older
 * engine — it just declines to merge a cluster it cannot see.
 */
export function graphemes(text) {
  const source = String(text ?? '');
  if (!source) return [];
  const Segmenter = typeof Intl === 'object' ? Intl.Segmenter : null;
  if (typeof Segmenter !== 'function') return Array.from(source);
  if (!graphemeSegmenter) graphemeSegmenter = new Segmenter('en', { granularity: 'grapheme' });
  return Array.from(graphemeSegmenter.segment(source), (entry) => entry.segment);
}

/** What one cluster costs: two cells when wide or pictographic, zero when all combining. */
export function graphemeWidth(cluster) {
  const chars = String(cluster ?? '');
  if (!chars) return 0;
  if (KEYCAP_RE.test(chars)) return 2;

  let width = 0;
  let marks = true;
  for (const char of chars) {
    if (ZERO_CELL_RE.test(char)) continue;
    marks = false;
    if (WIDE_CELL_RE.test(char) || PICTOGRAPHIC_RE.test(char)) return 2;
    width = 1;
  }
  return marks ? 0 : width;
}

/** How many cells `text` occupies on screen. */
export function displayWidth(text) {
  let width = 0;
  for (const cluster of graphemes(text)) width += graphemeWidth(cluster);
  return width;
}

/** The clusters of `text` up to — never into — `maxCells` display cells. */
export function clustersWithin(text, maxCells) {
  const limit = Math.max(0, Math.trunc(Number(maxCells)) || 0);
  const kept = [];
  let used = 0;
  for (const cluster of graphemes(text)) {
    const cells = graphemeWidth(cluster);
    if (used + cells > limit) break;
    kept.push(cluster);
    used += cells;
  }
  return kept;
}

/**
 * `text` cut down to at most `maxCells` display cells, with an `…` when something was
 * dropped. The ellipsis is charged to the budget, so the result never exceeds it —
 * which is the point: a row the box can hold stays one row.
 *
 * The cut is made between **grapheme clusters**, so a truncated line can never end on
 * half a surrogate pair or on half of an emoji.
 */
export function truncateToWidth(text, maxCells = DEFAULT_MAX_CELLS) {
  const source = String(text ?? '');
  const limit = Math.max(1, Math.trunc(Number(maxCells)) || DEFAULT_MAX_CELLS);
  if (displayWidth(source) <= limit) return source;
  return `${clustersWithin(source, limit - 1).join('')}…`;
}

/**
 * The **last** clusters of `text` that fit in `maxCells` display cells: what a
 * one-line box shows when the caret has run past its right edge, so the characters
 * nearest the caret are the ones kept.
 */
export function tailWithin(text, maxCells) {
  const limit = Math.max(0, Math.trunc(Number(maxCells)) || 0);
  const clusters = graphemes(text);
  let used = 0;
  let start = clusters.length;
  while (start > 0) {
    const cells = graphemeWidth(clusters[start - 1]);
    if (used + cells > limit) break;
    used += cells;
    start -= 1;
  }
  return { text: clusters.slice(start).join(''), cells: used };
}

/**
 * The first `maxChars` **grapheme clusters** of `text`, with an `…` when something was
 * dropped. For the truncations that count characters rather than cells (the
 * last-prompt hint, a one-line notice) but must still never cut a character in half
 * and leave a replacement glyph on screen.
 */
export function cutCodePoints(text, maxChars) {
  const source = String(text ?? '');
  const cap = Math.max(0, Math.trunc(Number(maxChars)) || 0);
  const clusters = graphemes(source);
  if (clusters.length <= cap) return source;
  if (cap <= 1) return cap === 1 ? '…' : '';
  return `${clusters.slice(0, cap - 1).join('')}…`;
}

export { WIDE_CELL_RE, ZERO_CELL_RE, PICTOGRAPHIC_RE, KEYCAP_RE };
