import { isColorName } from '../utils/color-names.js';

/**
 * **The** layer between a colour name and a blessed tag (`docs/interface/skins`).
 *
 * Every row the transcript paints asks this module for its tag instead of writing
 * `{${color}-fg}` by hand, for two reasons that are both bug reports:
 *
 *  1. **A skin has to reach every colour.** When a paint site interpolated a literal
 *     (`{cyan-fg}` for a fence, a file delimiter, a table frame or a quote), that colour
 *     was frozen at render time and no skin could move it — the look "saved and applied"
 *     while most of the screen stayed exactly as it was. A site now names a **palette
 *     key** (`{@frame-fg}`), which `resolveTags()` turns into the live value at *paint*
 *     time, so repainting the transcript repaints those rows too.
 *  2. **An unknown colour must never become a tag.** Blessed prints a tag it cannot
 *     resolve **literally** — `{orange-fg}` lands on screen as text — so a colour that is
 *     not in the vocabulary is caught here, in one place, instead of at a dozen call
 *     sites. `fgTag()` refuses it and falls back to the shipped default.
 *
 * The symbolic form uses `@` so it can never collide with a blessed tag: blessed's own
 * parser accepts `[\w\-,;!#]*` between braces, and `@` is not in that set, so an
 * unresolved symbolic tag is inert rather than a literal on screen.
 */

/** A symbolic tag: `{@frame-fg}`, `{/@quote-fg}`, `{@bullet-fg}`. */
const SYMBOLIC_RE = /\{\/?@([a-z][a-z0-9]*)(?:-(fg|bg))?\}/g;

/** The colour a paint site gets when the palette has nothing usable for its key. */
export const FALLBACK_COLOR = 'default';

/**
 * A real blessed foreground tag around `body`, or `body` alone.
 *
 * This is the only place a colour name becomes a tag. A name the terminal cannot paint
 * is refused rather than emitted, because the alternative is the tag appearing on screen
 * as literal text.
 */
export function fgTag(color, body = '') {
  const text = String(body ?? '');
  if (!text) return '';
  const name = isColorName(color) ? String(color).trim() : FALLBACK_COLOR;
  // `default` IS the absence of a colour (see `resolveTags()`): wrapping it would paint a row
  // the shipped palette leaves to the terminal, so the body comes back untouched.
  if (name === 'default') return text;
  return `{${name}-fg}${text}{/${name}-fg}`;
}

/** A real blessed tag pair (open, close) for callers wrapping content themselves. */
export function fgOpen(color) {
  const name = isColorName(color) ? String(color).trim() : FALLBACK_COLOR;
  return name === 'default' ? '' : `{${name}-fg}`;
}

/** The closing half of `fgOpen()`. */
export function fgClose(color) {
  const name = isColorName(color) ? String(color).trim() : FALLBACK_COLOR;
  return name === 'default' ? '' : `{/${name}-fg}`;
}

/** True when the text carries at least one unresolved symbolic tag. */
export function hasSymbolicTags(text) {
  SYMBOLIC_RE.lastIndex = 0;
  return SYMBOLIC_RE.test(String(text ?? ''));
}

/**
 * Turn every `{@key-fg}` in `text` into the colour `palette[key]` holds right now.
 *
 * A key the palette does not carry, or one whose value is not a paintable name, resolves
 * to `FALLBACK_COLOR` rather than being left in place: an unresolved symbol must never
 * reach the screen, and the fallback keeps the glyphs and the row width intact.
 *
 * Called on **every** line at paint time (`app/theme.js#colorizeLine`), which is what
 * makes a skin repaint a conversation that is already on screen.
 */
export function resolveTags(text, palette = {}) {
  const source = String(text ?? '');
  if (!source.includes('{@') && !source.includes('{/@')) return source;
  const pick = (key) => {
    const value = palette?.[key];
    return isColorName(value) ? String(value).trim() : FALLBACK_COLOR;
  };
  return source.replace(SYMBOLIC_RE, (match, key, kind = 'fg') => {
    // `{/@key-fg}` closes; anything else opens. `key` may be a palette key or, for a
    // caller that has only a colour name, that name itself — which `fgOpen()` would
    // have validated already, so both forms resolve the same way.
    const closing = match.startsWith('{/');
    const color = pick(key);
    // `default` IS the absence of a colour: blessed turns it into the terminal's own
    // foreground, so a tag for it would paint a row the shipped palette leaves to the
    // terminal. Resolving to no tag keeps the shipped bytes identical.
    if (color === 'default') return '';
    return closing ? `{/${color}-${kind}}` : `{${color}-${kind}}`;
  });
}

/**
 * Strip symbolic tags without resolving them, for a consumer that renders no colour
 * (a plain-text export, a width measurement on an unpainted line).
 */
export function stripSymbolicTags(text) {
  return String(text ?? '').replace(SYMBOLIC_RE, '');
}

/**
 * A symbolic foreground tag around `body`: what a render site emits when it wants a
 * palette key rather than a fixed colour.
 */
export function symbolicTag(key, body = '') {
  const text = String(body ?? '');
  if (!text) return '';
  return `{@${key}-fg}${text}{/@${key}-fg}`;
}