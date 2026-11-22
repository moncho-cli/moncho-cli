import fs from 'fs';
import path from 'path';
import { resolveProjectPath } from './path-safety.js';
import { writeFileVerified, readFileIfExists } from './file-io.js';
import {
  BLESSED_COLORS, BLESSED_BACKGROUNDS, isColorName, isBackgroundColorName,
} from './color-names.js';

/**
 * Skins: the per-project look of the conversation (`docs/interface/skins`).
 *
 * A **skin** is a saved look — the conversation palette (`app/theme.js`) plus a few
 * presentation tokens — kept as one JSON file per name under `agent/skins/<name>.json`.
 * `agent/` is the workspace's own state directory (gitignored), so a skin is a
 * per-project preference and never a chunk: nothing here reaches the model context or
 * a session file.
 *
 * The store owns three things and nothing else:
 *
 *  - the **shape** (`SKIN_KEYS`, `PALETTE_KEYS`) — a skin is a plain object whose every
 *    colour is a blessed colour *name* (`bright-blue`, `cyan`, `grey`), because a
 *    character-cell front end addresses cells and not pixels;
 *  - the **default** (`DEFAULT_SKIN`) — the palette `app/theme.js` already ships, so a
 *    project with no skin file looks exactly as it always did;
 *  - the **normalisation** (`normalizeSkin`) — a name, a partial palette and a JSON
 *    read off disk are all folded into the same canonical object, with unknown keys
 *    dropped and missing ones filled from the default.
 *
 * Writing goes through `utils/file-io.js#writeFileVerified`, so a saved skin is read
 * back and proven byte-for-byte before success is reported, and the path is resolved
 * through the same sandbox every file tool uses (`utils/path-safety.js`).
 */

/** Project-relative folder skins live in. `agent/` is the gitignored state tree. */
export const SKINS_DIR = process.env.SKINS_DIR || 'agent/skins';

/** The file the active skin's *name* is remembered in, beside the skins themselves. */
export const ACTIVE_FILE = `${SKINS_DIR}/active.json`;

/**
 * The one colour per kind of conversation row (`app/theme.js#CONVERSATION_COLORS`).
 * A skin must name a colour for every one of these; it may name none of the others.
 */
export const PALETTE_KEYS = Object.freeze([
  'user', 'tool', 'intent', 'context', 'error', 'notice', 'stamp', 'tracking', 'refusal',
  // the chrome the renderer paints: a fence, a table frame, inline code, a quote, a
  // list bullet, a heading. They are palette keys so a skin moves them too
  // (`app/paint-tags.js`, `docs/interface/skins`).
  'frame', 'table', 'code', 'quote', 'bullet', 'heading',
  // the three tool families (`app/tool-palette.js`): looking, changing, running
  'toolRead', 'toolWrite', 'toolBash',
]);

/** The presentation tokens a skin may carry besides the palette. */
export const PRESENTATION_KEYS = Object.freeze([
  'border', 'brand', 'hint', 'selected', 'selectedFg',
  // the two prose backgrounds (`app/prose-band.js`): the band behind the user's echoed
  // prompt and the band behind the model's prose. They are tokens rather than palette
  // keys because a band is a *background* on a whole row, not the foreground of a row's
  // kind — but they are live exactly like the palette, so `userBg=green` reaches the
  // screen. Their absence was the reported bug: every request for a background was
  // answered with a foreground, so the band never moved and the change "did nothing".
  'userBg', 'assistantBg',
  'boldIntent', 'boldTracking',
]);

/** Every top-level key a canonical skin holds. */
export const SKIN_KEYS = Object.freeze(['name', 'palette', ...PRESENTATION_KEYS]);

/** The paintable colour names a skin may use (re-exported from the leaf vocabulary). */
export { BLESSED_COLORS, BLESSED_BACKGROUNDS, isColorName, isBackgroundColorName };

/**
 * The tokens whose value is a **background**.
 *
 * `selected`, `userBg` and `assistantBg` are painted with `{<colour>-bg}`, so they go
 * through the background vocabulary (`utils/color-names.js#BLESSED_BACKGROUNDS`) rather
 * than the foreground one. The two vocabularies hold the same names today — blessed paints
 * a bright background as well as a bright foreground — but they are kept apart because a
 * background is a different question, and a name the switch has no case for would be
 * printed literally on the row the band was meant to fill.
 */
export const BACKGROUND_KEYS = Object.freeze(['selected', 'userBg', 'assistantBg']);

/** A skin name: it becomes a file name, so it stays a plain slug. */
export const SKIN_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/** The palette `app/theme.js` ships; a project with no skin looks exactly like this. */
export const DEFAULT_PALETTE = Object.freeze({
  user: 'cyan',
  tool: 'yellow',
  intent: 'bright-blue',
  context: 'magenta',
  error: 'red',
  notice: 'grey',
  // the `HH:MM:SS` mark in front of a transcript row. The terminal's own foreground, so a
  // timestamp is legible on a default (black) terminal; `grey` is ANSI bright black and all
  // but vanishes there. A skin may still move it (`app/theme-colors.js#colorizeStamp`).
  stamp: 'default',
  tracking: 'bright-green',
  refusal: 'bright-red',
  // the chrome the markdown renderer and the tool delimiters paint; these are the exact
  // literals that used to be hardcoded in app/tui-render.js and app/markdown-table.js
  frame: 'cyan',
  table: 'cyan',
  code: 'cyan',
  quote: 'bright-white',
  bullet: 'green',
  heading: 'default',
  toolRead: 'bright-cyan',
  toolWrite: 'green',
  toolBash: 'yellow',
});

/** The presentation tokens `app/theme.js` and the bars ship. */
export const DEFAULT_PRESENTATION = Object.freeze({
  /** the border colour of the modal / picker boxes */
  border: 'cyan',
  /** the brand line's colour (`app/brand.js#BRAND_COLOR`) */
  brand: 'bright-white',
  /** the dim hint over an empty input box (`app/input-hint.js#HINT_COLOR`) */
  hint: 'grey',
  /** the band behind the selected slash-command row (`app/theme.js#SLASH_COLORS`) */
  selected: 'blue',
  /** the text on that band */
  selectedFg: 'white',
  /**
   * the background band behind the user's echoed prompt (`app/prose-band.js`). `blue` is
   * the one coloured band a terminal is certain to paint, which is why it is the shipped
   * value rather than a brighter one — a bright background glares under a whole block.
   */
  userBg: 'blue',
  /**
   * the background band behind the model's prose. The dark `red` (`\x1b[41m`), not the
   * bright form: the band sits under the whole foreground palette, so it has to stay
   * legible, and it must differ from the user's band.
   */
  assistantBg: 'red',
  /** whether the intent is bold as well as coloured (`app/theme.js#INTENT_BOLD`) */
  boldIntent: true,
  /** whether a `[Tracking]` row is bold (`app/theme.js#TRACKING_BOLD`) */
  boldTracking: true,
});

/** The name the built-in skin is known by. */
export const DEFAULT_SKIN_NAME = 'default';

/**
 * The built-in skin: the palette and tokens the project already ships. It is never
 * written to disk (there is nothing to remember), so it is the value `/skins` reports
 * before any skin file exists and the fallback `/skins reset` restores.
 */
export const DEFAULT_SKIN = Object.freeze({
  name: DEFAULT_SKIN_NAME,
  palette: DEFAULT_PALETTE,
  ...DEFAULT_PRESENTATION,
});

/**
 * Fold anything skin-shaped into the canonical object.
 *
 * `name` is slugged from the input (or the default name); each palette key takes the
 * input's colour when it is a valid colour name and the default otherwise, so a typo
 * degrades to the shipped colour instead of a broken tag; the presentation tokens take
 * their own type (colour names for the colour ones, booleans for the two bolds). A
 * non-object input normalises to the default skin rather than throwing: a corrupt file
 * must never leave the session unreadable.
 *
 * @param {object|string} [input] a partial skin, or a bare name
 * @returns {object} the canonical skin
 */
export function normalizeSkin(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const name = slugName(raw.name ?? (typeof input === 'string' ? input : '')) || DEFAULT_SKIN_NAME;
  const given = raw.palette && typeof raw.palette === 'object' ? raw.palette : {};
  const source = { ...raw, ...given, palette: undefined };

  const palette = {};
  for (const key of PALETTE_KEYS) {
    palette[key] = isColorName(given[key]) ? given[key].trim() : DEFAULT_PALETTE[key];
  }

  const skin = { name, palette };
  for (const key of ['border', 'brand', 'hint', 'selected', 'selectedFg', 'userBg', 'assistantBg']) {
    // The three background tokens go through the background vocabulary: a band named with
    // a colour blessed cannot paint as a background would put a literal tag on the row.
    const usable = BACKGROUND_KEYS.includes(key) ? isBackgroundColorName : isColorName;
    skin[key] = usable(source[key]) ? source[key].trim() : DEFAULT_PRESENTATION[key];
  }
  for (const key of ['boldIntent', 'boldTracking']) {
    skin[key] = typeof source[key] === 'boolean' ? source[key] : DEFAULT_PRESENTATION[key];
  }
  return skin;
}

/** A name turned into a safe file-name slug, or `''` when nothing usable is left. */
export function slugName(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!text) return '';
  const cleaned = text.replace(/[^a-z0-9._-]/g, '');
  return SKIN_NAME_RE.test(cleaned) ? cleaned : '';
}

/** Project-relative path of one skin's JSON file. */
export function skinPath(name, { dir = SKINS_DIR } = {}) {
  const slug = slugName(name);
  if (!slug) throw new Error(`"${name}" is not a usable skin name.`);
  return `${dir}/${slug}.json`;
}

/** The project-relative paths of every skin file the project holds, sorted by name. */
export function listSkinPaths({ dir = SKINS_DIR } = {}) {
  const abs = resolveProjectPath(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return [];
  return fs.readdirSync(abs)
    .filter((entry) => entry.endsWith('.json') && entry !== path.basename(ACTIVE_FILE))
    .sort((a, b) => a.localeCompare(b))
    .map((entry) => `${dir}/${entry}`);
}

/**
 * Every skin the project holds, `default` first.
 *
 * A file that cannot be read or parsed is reported as its own entry with an `error`
 * rather than dropped, so `/skins` can name a corrupt file instead of hiding it.
 *
 * @returns {object[]} canonical skins, each with `name` and `palette`
 */
export function listSkins({ dir = SKINS_DIR } = {}) {
  const out = [{ ...DEFAULT_SKIN, builtin: true }];
  for (const file of listSkinPaths({ dir })) {
    const bare = path.basename(file, '.json');
    try {
      const content = readFileIfExists(file);
      const parsed = JSON.parse(content);
      out.push({ ...normalizeSkin({ ...parsed, name: parsed?.name ?? bare }), path: file });
    } catch (error) {
      out.push({ name: bare, path: file, error: error.message });
    }
  }
  return out;
}

/** Read one skin by name (or path), or `null` when there is no such file. */
export function readSkin(name, { dir = SKINS_DIR } = {}) {
  if (slugName(name) === DEFAULT_SKIN_NAME) return { ...DEFAULT_SKIN, builtin: true };
  const file = skinPath(name, { dir });
  const content = readFileIfExists(file);
  if (content === null) return null;
  const parsed = JSON.parse(content);
  return { ...normalizeSkin({ ...parsed, name: parsed?.name ?? slugName(name) }), path: file };
}

/**
 * Save a skin under its name, verifying the bytes landed.
 *
 * @param {object|string} skin a skin-shaped object, or a name
 * @returns {{path: string, skin: object, created: boolean}}
 */
export function saveSkin(skin, { dir = SKINS_DIR } = {}) {
  const canonical = normalizeSkin(skin);
  if (canonical.name === DEFAULT_SKIN_NAME) {
    throw new Error('The built-in default skin is not saved to disk; use another name.');
  }
  const file = skinPath(canonical.name, { dir });
  const body = `${JSON.stringify(canonical, null, 2)}\n`;
  const result = writeFileVerified(file, body);
  return { path: file, skin: canonical, created: result.created };
}

/** Delete one skin file (the built-in default is never on disk to delete). */
export function deleteSkin(name, { dir = SKINS_DIR } = {}) {
  const file = skinPath(name, { dir });
  const abs = resolveProjectPath(file);
  if (!fs.existsSync(abs)) return { path: file, deleted: false };
  fs.unlinkSync(abs);
  return { path: file, deleted: true };
}

/**
 * Remember which skin the project is using, or read it back.
 *
 * The record is one small JSON file (`agent/skins/active.json`) holding `{ name }`, so
 * opening the project again repaints in the same skin without a restart argument. A
 * missing or corrupt record answers the default name, never an error.
 */
export function readActiveName({ dir = SKINS_DIR } = {}) {
  try {
    const content = readFileIfExists(ACTIVE_FILE.replace(SKINS_DIR, dir));
    if (content === null) return DEFAULT_SKIN_NAME;
    const parsed = JSON.parse(content);
    return slugName(parsed?.name) || DEFAULT_SKIN_NAME;
  } catch {
    return DEFAULT_SKIN_NAME;
  }
}

/** Write the active skin's name, or clear it back to the default. */
export function writeActiveName(name, { dir = SKINS_DIR } = {}) {
  const slug = slugName(name) || DEFAULT_SKIN_NAME;
  const file = ACTIVE_FILE.replace(SKINS_DIR, dir);
  writeFileVerified(file, `${JSON.stringify({ name: slug }, null, 2)}\n`);
  return slug;
}
