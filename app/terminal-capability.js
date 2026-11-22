/**
 * What the terminal in front of the user will actually show (`docs/interface/skins`).
 *
 * A skin may name any colour blessed paints, and blessed paints them all — but the
 * **terminal** decides how much of it reaches the screen. Two reductions happen, and both
 * are quiet, so both are reported here rather than left to be guessed at:
 *
 *  - **a bright background on a terminal with fewer than sixteen colours** is reduced to
 *    its base colour (blessed's own reduction, `lib/widgets/screen.js#_reduceColor`).
 *    `bright-blue` paints as `blue`: the colour is honoured, and the screen shows the
 *    quieter form of it.
 *  - **the grey family** is reduced to the terminal's *default* background at every
 *    capability: blessed spells `grey bg` as `\x1b[100m`, and its own render path reads
 *    that escape as "default foreground and background" (`screen.js#attrCode`, `case 100`),
 *    so the band is not painted at all. `light-grey` is different — blessed spells it
 *    `\x1b[47m`, which is the white background.
 *
 * Both facts are read off the library rather than assumed: the escapes come from
 * `program.js#_attr` and the reductions from `colors.reduce`, and `tests/skins-colors.test.js`
 * proves them against the real blessed.
 *
 * A leaf module on purpose: the count is set once from the real screen
 * (`app/tui-screen.js`) and read by the skins command, which must not drag the terminal
 * wiring into the theme layer.
 */

/** The colour count of a terminal that was never asked. */
export const UNKNOWN_COLOR_COUNT = null;

/** The colour count of the terminal in force, or `null` when it was never reported. */
let colorCount = UNKNOWN_COLOR_COUNT;

/**
 * Record the terminal's colour count.
 *
 * @param {number|null} count the number of colours the terminal supports
 * @returns {number|null} the count now in force
 */
export function setTerminalColorCount(count) {
  colorCount = Number.isFinite(count) && count > 0 ? Number(count) : UNKNOWN_COLOR_COUNT;
  return colorCount;
}

/** The terminal's colour count, or `null` when it was never reported. */
export function terminalColorCount() {
  return colorCount;
}

/**
 * True when the terminal can show the bright form of a colour.
 *
 * An unknown count answers `true`: a terminal that never reported its capability is not
 * evidence against the bright form, and refusing to say would only hide the request.
 */
export function supportsBrightColors(count = colorCount) {
  return count === UNKNOWN_COLOR_COUNT || count >= 16;
}

/**
 * The colour each bright/light name becomes on a terminal with fewer than sixteen colours.
 *
 * Taken from blessed's own reduction (`colors.reduce` drops the bright half of the index,
 * and `screen.js#attrCode` maps `100`–`107` to index `8`–`15`).
 */
const BRIGHT_TO_BASE = Object.freeze({
  'bright-red': 'red', 'light-red': 'red',
  'bright-green': 'green', 'light-green': 'green',
  'bright-yellow': 'yellow', 'light-yellow': 'yellow',
  'bright-blue': 'blue', 'light-blue': 'blue',
  'bright-magenta': 'magenta', 'light-magenta': 'magenta',
  'bright-cyan': 'cyan', 'light-cyan': 'cyan',
  'bright-white': 'white', 'light-white': 'white',
  // blessed spells the light grey spellings `\x1b[47m` — the white background.
  'bright-grey': 'white', 'light-grey': 'white',
  'bright-gray': 'white', 'light-gray': 'white',
});

/**
 * The names blessed paints as the terminal's **default** background, at every capability.
 *
 * `grey`/`gray` are the bright black in blessed's *foreground* spelling, but as a
 * background the switch answers `\x1b[100m` — the escape its own render path reads as
 * "default foreground and background" (`screen.js#attrCode`, `case 100`). The band is
 * therefore not painted: the row shows the terminal's own background.
 */
const DEFAULT_BACKGROUNDS = Object.freeze(['grey', 'gray', 'light-black', 'bright-black']);

/**
 * The background colour the terminal will really paint for `name`.
 *
 * The name itself on a terminal that can show it, its base colour on one that cannot, and
 * `default` for the names blessed paints as the terminal's own background. An unknown
 * capability answers the name itself: an unknown terminal is not evidence against the
 * bright form.
 *
 * @param {string} name the colour name a skin asked for
 * @param {number|null} [count] the terminal's colour count
 * @returns {string} the colour that reaches the screen
 */
export function effectiveBackgroundName(name, count = colorCount) {
  const text = String(name ?? '').trim();
  if (!text) return text;
  if (DEFAULT_BACKGROUNDS.includes(text)) return 'default';
  if (supportsBrightColors(count)) return text;
  return BRIGHT_TO_BASE[text] ?? text;
}

/**
 * The backgrounds among `tokens` the terminal will not show in the form they were asked for.
 *
 * @param {object} tokens the live token set
 * @param {string[]} keys the tokens that are backgrounds (`utils/skins-store.js#BACKGROUND_KEYS`)
 * @param {number|null} [count] the terminal's colour count
 * @returns {object} `{ [token]: { requested, effective } }`
 */
export function reducedBackgrounds(tokens = {}, keys = [], count = colorCount) {
  const out = {};
  for (const key of keys) {
    const requested = tokens?.[key];
    if (requested === undefined) continue;
    const effective = effectiveBackgroundName(requested, count);
    if (effective !== requested) out[key] = { requested, effective };
  }
  return out;
}
