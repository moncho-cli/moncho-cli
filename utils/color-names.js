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
 * The colour names blessed can paint as a **background**.
 *
 * The **same** closed set as `BLESSED_COLORS`, and that equality is the whole point:
 * blessed's `_attr()` (`program.js`) has a case for every base *and* every bright/light
 * background (`blue bg` → `\x1b[44m`, `bright blue bg` → `\x1b[104m`), so a tag such as
 * `{bright-blue-bg}` resolves to a real escape instead of being printed as text.
 *
 * What makes it work is the **tag parser**, not the switch alone:
 * `lib/widgets/element.js#_parseTags` rewrites every `-` of a tag to a space
 * (`param = cap[2].replace(/-/g, ' ')`) before it asks for the escape, so `{bright-blue-bg}`
 * reaches `_attr()` as `bright blue bg` — the spelling the switch has a case for. Ask
 * `_attr()` for the hyphenated `bright-blue bg` instead and it answers `null`, which is how
 * a background can look unpaintable while painting perfectly well. The mistake this set was
 * built on cost the skins module its bright backgrounds.
 *
 * The two lists are kept apart on purpose: `BLESSED_BACKGROUNDS` is the door a **background**
 * token goes through, and `tests/skins-colors.test.js` proves it against the real library, so
 * a name the switch has no case for cannot slip into it.
 */
export const BLESSED_BACKGROUNDS = Object.freeze([...BLESSED_COLORS]);

/** Membership is O(1) and the set is the frozen list above, spelled lowercase. */
const PAINTABLE_BACKGROUND = new Set(BLESSED_BACKGROUNDS);

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

/**
 * True when `value` is a colour name blessed can paint as a **background**.
 *
 * Today that is every paintable name (`BLESSED_BACKGROUNDS` above), so the answer is the
 * same as `isColorName()` — but it is kept as its own door because a background is a
 * different thing to ask about: this is the vocabulary a band may be named with, and a name
 * the switch has no case for would be printed literally on the row the band was meant to
 * fill.
 */
export function isBackgroundColorName(value) {
  return typeof value === 'string' && PAINTABLE_BACKGROUND.has(value.trim());
}
