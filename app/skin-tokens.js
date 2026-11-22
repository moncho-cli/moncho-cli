import {
  PALETTE_KEYS, PRESENTATION_KEYS, BACKGROUND_KEYS, readActiveName, slugName,
  isColorName, isBackgroundColorName,
} from '../utils/skins-store.js';

/**
 * The `/skins` **grammar and its tokens** (`docs/interface/skins`): how one command line is
 * split into a subcommand, which `key=value` pairs a skin accepts, and how a refusal names
 * the value it could not take.
 *
 * Split out of `app/skins-command.js` so that module stays the *router* — it decides what to
 * do and owns the store writes — while this one owns the shape of the input. The distinction
 * is a real one: the grammar is pure (a string in, a parsed object out) and unit tested
 * without a store, and the command is the only place that touches disk.
 */

/**
 * The presentation tokens whose value is a colour name (the two booleans are handled
 * separately). `userBg`/`assistantBg` are the two prose bands (`app/prose-band.js`): they
 * are here and not in `PALETTE_KEYS` because a band is a background over a whole row, and
 * naming them is what lets a request for a background actually reach the screen —
 * previously there was no token to name, so `/skins warm userBg=green` was `BAD_VALUE`.
 */
export const COLOR_TOKEN_KEYS = Object.freeze([
  'border', 'brand', 'hint', 'selected', 'selectedFg', 'userBg', 'assistantBg',
]);

/** The boolean tokens a skin may carry. */
export const BOOLEAN_TOKEN_KEYS = Object.freeze(['boldIntent', 'boldTracking']);

/** A few names from each end of the vocabulary, short enough to read in one line. */
export const SUGGESTED_COLORS = Object.freeze(['bright-blue', 'cyan', 'grey', 'bright-red', 'white']);

/** Where a skin's own name goes when it is not given: the persisted active skin. */
export function activeName(ctx = {}) {
  return slugName(ctx.activeName) || readActiveName({ dir: ctx.skinsDir });
}

/** The `tokens=` arguments of the command, or a refusal naming the bad one. */
export function parseTokens(pairs = {}) {
  const palette = {};
  const tokens = {};
  for (const [key, value] of Object.entries(pairs)) {
    const raw = String(value ?? '').trim();
    if (PALETTE_KEYS.includes(key)) {
      if (!isColorName(raw)) return { error: raw, key };
      palette[key] = raw;
      continue;
    }
    if (COLOR_TOKEN_KEYS.includes(key)) {
      // The three background tokens go through the background vocabulary. It holds the
      // same names as the foreground one — blessed paints a bright background as well as
      // a bright foreground — but it is the door a band is named through, so a colour the
      // switch cannot paint as a background is refused here rather than printed on the row.
      const isBackground = BACKGROUND_KEYS.includes(key);
      const usable = isBackground ? isBackgroundColorName : isColorName;
      if (!usable(raw)) return { error: raw, key, background: isBackground };
      tokens[key] = raw;
      continue;
    }
    if (BOOLEAN_TOKEN_KEYS.includes(key)) {
      if (raw !== 'true' && raw !== 'false') return { error: raw, key, boolean: true };
      tokens[key] = raw === 'true';
      continue;
    }
    return { error: key, key, unknown: true };
  }
  return { palette, tokens };
}

/** The one-line list of every colour token a skin takes, for the unknown-key refusal. */
export function colorTalkLabel() {
  return [
    'The row colours are user, tool, intent, context, error, notice, tracking, refusal',
    'the chrome is frame, table, code, quote, bullet, heading',
    'the tool families are toolRead, toolWrite, toolBash',
    `the look is ${[...COLOR_TOKEN_KEYS, ...BOOLEAN_TOKEN_KEYS].join(', ')}`,
  ].join('; ') + '.';
}

/**
 * The refusal for a `key=value` the command could not take, naming the **value** first.
 *
 * Three different mistakes reach here and they deserve three different sentences: a colour
 * the terminal cannot paint (`orange` — a blessed tag it does not know is printed
 * literally, so it must be refused rather than saved), a boolean that is not `true`/`false`,
 * and a key no skin has. Naming the key alone left the user guessing which of their
 * arguments was wrong.
 */
export function badValueMessage({ error, key, boolean, unknown, background = false }) {
  if (unknown) return `"${error}" is not a skin token. ${colorTalkLabel()}`;
  if (boolean) return `"${key}=${error}" needs true or false.`;
  // A background names the door the colour was refused at, so the reader knows which of
  // their tokens was wrong. The vocabulary is the same as a foreground's — blessed paints a
  // bright background as well as a bright foreground — so the sentence says what is
  // actually true: the name is one blessed cannot paint at all.
  if (background) {
    return `"${error}" is not a colour this terminal can paint as a background (${key}=${error}). Use a name like ${SUGGESTED_COLORS.join(', ')}.`;
  }
  return `"${error}" is not a colour this terminal can paint (${key}=${error}). Use a name like ${SUGGESTED_COLORS.join(', ')}.`;
}

/**
 * Split a `/skins` argument into a subcommand.
 *
 * The grammar is small on purpose: a leading verb wins (`list`, `save`, `reset`,
 * `prompt`), otherwise the first bare word is a skin name and any `key=value` after it
 * are tokens, and a bare `name` with nothing after it is an apply. `save` may follow
 * the token list, which is what lets a look be built and written in one line.
 */
export function parseSkinsArgs(arg = '') {
  const parts = String(arg ?? '').trim().split(/\s+/).filter(Boolean);
  const verb = parts[0]?.toLowerCase();
  if (!verb) return { action: 'list' };
  if (verb === 'list') return { action: 'list' };
  if (verb === 'reset') return { action: 'reset' };
  if (verb === 'prompt') return { action: 'prompt', request: parts.slice(1).join(' ') };
  if (verb === 'customize') return { action: 'customize', request: parts.slice(1).join(' ') };
  if (verb === 'save') return { action: 'save', name: parts[1] || '' };

  const name = parts[0];
  const pairs = {};
  let save = false;
  let saveAs = name;
  const rest = parts.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.toLowerCase() === 'save') {
      save = true;
      // A bare word right after `save` names the skin to write; without one the
      // look is saved over the skin it was built from.
      const next = rest[i + 1];
      if (next && next.indexOf('=') < 0) { saveAs = next; i += 1; }
      continue;
    }
    const eq = token.indexOf('=');
    if (eq < 0) return { action: 'unknown', token };
    const key = token.slice(0, eq).trim();
    const value = token.slice(eq + 1).trim();
    if (key === 'name') { saveAs = value; continue; }
    pairs[key] = value;
  }
  return { action: save ? 'apply-save' : 'apply', name, saveAs, pairs };
}

/** One line per palette/token for a listing, so a skin is readable at a glance. */
export function formatSkinLines(skin, { active = false } = {}) {
  const flag = active ? ' (active)' : '';
  const palette = PALETTE_KEYS.map((key) => `${key}=${skin.palette?.[key] ?? '?'}`).join(' ');
  const tokens = PRESENTATION_KEYS.map((key) => `${key}=${skin[key] ?? '?'}`).join(' ');
  return [`${skin.name}${flag}`, `  palette: ${palette}`, `  tokens:  ${tokens}`];
}
