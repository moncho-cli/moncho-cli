/**
 * The colour names a character-cell terminal can actually paint.
 *
 * A blessed tag like `{orange-fg}` is **not** an error a widget reports: the tag parser
 * asks `program._attr()` for the escape, gets `null` for a name it does not know, and
 * prints the tag **literally** — the row shows `{orange-fg}…{/orange-fg}` instead of a
 * colour. So "a colour name" is only meaningful if it is one of the names blessed
 * resolves, and that is exactly the list below.
 *
 * It is the vocabulary `node_modules/neo-blessed/lib/program.js#_attr` switches over,
 * spelled the way a tag spells it (hyphens; the parser rewrites `-` to the space the
 * colour switch uses, which is why `bright-blue` is a name and `brightblue` is not).
 * The list is deliberately a **closed set** rather than a pattern: a pattern accepted
 * `orange`, and `orange` is the example the docs used, so the shipped example painted
 * literal tag text.
 *
 * Kept as a leaf module (no imports) so both the store (`utils/skins-store.js`) and the
 * live palette (`app/theme-palette.js`) share one vocabulary without the render path
 * pulling in the filesystem.
 */

/** The paintable colour names, exactly as a blessed tag spells them. */
export const BLESSED_COLORS = Object.freeze([
  // the eight base colours
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  // grey is the bright black; gray is the American spelling blessed also knows
  'grey', 'gray',
  // the bright / light variants (blessed treats the two words as synonyms)
  'light-black', 'bright-black',
  'light-red', 'bright-red',
  'light-green', 'bright-green',
  'light-yellow', 'bright-yellow',
  'light-blue', 'bright-blue',
  'light-magenta', 'bright-magenta',
  'light-cyan', 'bright-cyan',
  'light-white', 'bright-white',
  'light-grey', 'light-gray', 'bright-grey', 'bright-gray',
  // the terminal's own default foreground
  'default',
]);

/** Membership is O(1) and the set is the frozen list above, spelled lowercase. */
const PAINTABLE = new Set(BLESSED_COLORS);

/**
 * True when `value` is a colour name this terminal can really paint.
 *
 * Strict on purpose: the name must already be canonical (lowercase, hyphenated), because
 * a name the tag parser does not recognise is printed literally rather than painted —
 * accepting `Cyan` or `orange` would put the tag on screen as text.
 */
export function isColorName(value) {
  return typeof value === 'string' && PAINTABLE.has(value.trim());
}
