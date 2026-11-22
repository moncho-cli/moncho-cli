import { isColorName, isBackgroundColorName } from '../utils/color-names.js';
import { PROSE_BACKGROUNDS, ROLE_OF_BAND_TOKEN } from './band-palette.js';

// The row painters (the intent, a tracking update, a refusal, a timestamp) live in
// `app/theme-colors.js`: they are the *presentation* of one row rather than a value of the
// palette. Re-exported here because this is the path every consumer and every spec reaches
// for a live colour or tag through.
export { colorizeIntent, colorizeTracking, colorizeRefusal, colorizeStamp } from './theme-colors.js';
import {
  activeSkinName, setSkinName, markSkinBootstrapped, isSkinBootstrapped,
  clearSkinBootstrapped, restoreSkinName,
} from './skin-identity.js';

// The two prose backgrounds are the leaf module's live object (`app/band-palette.js`) and
// the skin identity/bootstrap flag its own (`app/skin-identity.js`); both are re-exported
// here because this is the one place the rest of the program reads live theme state from
// (`app/theme.js` re-exports this module's names), so a consumer's import never changes.
export { PROSE_BACKGROUNDS } from './band-palette.js';
export {
  activeSkinName, markSkinBootstrapped, isSkinBootstrapped, restoreSkinName,
} from './skin-identity.js';

/**
 * The **live** conversation palette (`docs/interface/skins`): one colour per kind of
 * transcript row, the slash-popup band, and the few presentation tokens a skin may move.
 *
 * Split from `app/theme.js` so that module stays the *classification* (which kind of row
 * is this, and how is it painted) while this one owns the *state* (what the colours are
 * right now, and how a skin moves them). Colour is presentation only: nothing here
 * reaches a chunk, a session file or the line CLI.
 *
 * The objects below are **not frozen**. `setPalette()`/`setTokens()`/`applySkin()` mutate
 * them **in place**, which is what lets a skin repaint a running transcript without any
 * module that already imported a colour having to be re-imported. The values declared
 * here are therefore the **defaults** a project with no skin sees, and `resetTheme()`
 * restores them.
 */

/** Marker introducing an echoed user message; it is what identifies a user row. */
export const USER_ECHO_HEADER = 'You:';

/**
 * One colour name (a blessed tag colour) per kind of transcript row.
 *
 * The intent is `bright-blue` rather than the `blue` the terminal calls normal: that blue
 * is dark and disappears against a black background, while the bright variant is the one a
 * reader can pick out inside a tool block. The name is hyphenated because blessed's tag
 * parser rewrites `-` into a space and its colour switch spells the bright variant
 * `bright blue fg` (node_modules/neo-blessed/lib/program.js#_attr): `brightblue` on its own
 * is not a tag name and would be printed literally as `{brightblue-fg}`; the tag name and
 * the escape it paints are asserted in `tests/conversation-colors.test.js` instead.
 */
export const CONVERSATION_COLORS = {
  /** the `You:` header of the echoed prompt */
  user: 'cyan',
  /**
   * a tool row that names no tool this palette knows: a *named* one is painted by its
   * operation family (app/tool-palette.js), and this is the fallback colour
   */
  tool: 'yellow',
  /** the reason for a tool call: the `intent:` row and the `intent:` span */
  intent: 'bright-blue',
  /** `[Context]` notices: usage and compaction */
  context: 'magenta',
  /** errors and warnings */
  error: 'red',
  /** low-key chrome: `[Info]`, `[Session]`, `[pasted …]`, horizontal rules */
  notice: 'grey',
  /**
   * the `HH:MM:SS` mark in front of a transcript row. It is the terminal's own
   * foreground (`default`), not `grey`: `grey` is ANSI bright black, which all but
   * vanishes on a black background — the reported bug — while `default` follows the
   * terminal, so the mark is readable on a dark *and* a light theme without a skin.
   */
  stamp: 'default',
  /** a `[Tracking]` row: a task.md / implementation_plan.md update */
  tracking: 'bright-green',
  /**
   * a refused tool call: the `✖ Refused …` row `formatRefusalLine()` writes; the bright
   * red no other row uses
   */
  refusal: 'bright-red',

  // --- The chrome the renderer paints ------------------------------------------------
  //
  // These are the colours a markdown or tool-delimiter row is drawn in. They used to be
  // literals inside `app/tui-render.js` and `app/markdown-table.js` (`{cyan-fg}` for a
  // fence, a file header, a table frame), which is why a skin could be applied and most of
  // the screen stayed exactly as it was. They are palette keys now, so every one of them
  // follows a skin, and the shipped values are the literals that were there before — a
  // project with no skin looks byte-for-byte the same.

  /** the `┌─ <path>` / `└─────` delimiters of a tool result, and a fenced code block */
  frame: 'cyan',
  /** a markdown table's rules and pipes */
  table: 'cyan',
  /** inline `code` inside a row */
  code: 'cyan',
  /** a quoted line (`│ …`) — the user's echo lines and a markdown blockquote */
  quote: 'bright-white',
  /** the `•` of a list item */
  bullet: 'green',
  /** a markdown heading: bold and underlined, in this colour */
  heading: 'default',

  // --- The tool families --------------------------------------------------------------
  //
  // `app/tool-palette.js` subdivides the tool kind so a screenful of tool rows can be read
  // at a glance: looking, changing, running. The three colours used to be constants in that
  // module, so a skin could not touch them. They are palette keys now, which keeps the
  // subdivision *and* lets a skin choose the three; `tool` above stays the fallback for a
  // tool nobody classified.
  /** a read: `read_file`, `grep`, `blob`, `web_fetch` — looking, no change */
  toolRead: 'bright-cyan',
  /** a write: `write_file`, `edit_file`, `delete_file` — the tree changed */
  toolWrite: 'green',
  /** a shell: `run_bash`, `run_npm` — a process ran */
  toolBash: 'yellow',
};

/** The colour the intent is painted in (task-backlog: "a brightish blue"). */
export const INTENT_COLOR = CONVERSATION_COLORS.intent;

/** The attribute, besides the colour, that makes the intent findable. */
export const INTENT_BOLD = true;

/** The colour a tracking update is painted in, so it never reads as a tool row. */
export const TRACKING_COLOR = CONVERSATION_COLORS.tracking;
/** Tracking updates are milestones, so they carry bold as well as the colour. */
export const TRACKING_BOLD = true;

/** The colour a timestamp is painted in: chrome, never the row it introduces. */
export const STAMP_COLOR = CONVERSATION_COLORS.stamp;

/** The colour a refused call is painted in: impossible to mistake for prose. */
export const REFUSAL_COLOR = CONVERSATION_COLORS.refusal;
/** A refusal is news, so it carries bold as well as the bright colour. */
export const REFUSAL_BOLD = true;

/**
 * The slash-command popup's selection (`app/slash-bar.js`): a **solid band** on the row
 * the cursor is on, spelled as a blessed background tag.
 *
 * It is not part of `CONVERSATION_COLORS` because it is not a transcript row — it is a
 * highlight painted *behind* a row for as long as the arrow keys leave it there. The
 * background is the normal `blue` rather than the `bright-blue` the intent uses: a fill
 * this wide at the intent's brightness glares, and the foreground is `white` rather than
 * the default because a background cannot inherit the terminal's own text colour.
 */
export const SLASH_COLORS = {
  /** the band behind the selected row */
  selected: 'blue',
  /** the text on top of that band */
  selectedFg: 'white',
};

/**
 * The two background bands around the sides of the dialogue live in `app/band-palette.js`
 * (imported and re-exported above) because `app/prose-band.js` reads them and must not pull
 * this module into the render path. `setTokens()` mutates that object **in place**, so
 * `bandColor()` — and therefore every band on screen — follows a skin at paint time.
 *
 * Their values, the dark form each is and why, are documented where they live
 * (`app/band-palette.js`); the absence of a band key was the reported bug — every request
 * in the log asked for a *background*, there was no token for one, so the model moved the
 * nearest foreground, reported success, and the band stayed exactly as it was.
 *
 * The presentation tokens a skin may move besides the palette are below: a border, the brand
 * line, the input hint and the two bold attributes. Live, exactly like `CONVERSATION_COLORS`.
 */
export const THEME_TOKENS = {
  /** the border of the modal / picker boxes (`app/tui-modal.js`) */
  border: 'cyan',
  /** the brand line (`app/brand.js#BRAND_COLOR`) */
  brand: 'bright-white',
  /** the dim hint over an empty input box (`app/input-hint.js#HINT_COLOR`) */
  hint: 'grey',
  /** whether an intent row is bold as well as coloured (`INTENT_BOLD`) */
  boldIntent: true,
  /** whether a `[Tracking]` row is bold (`TRACKING_BOLD`) */
  boldTracking: true,
};

// `isColorName` (the closed vocabulary of names a blessed tag really paints) comes from
// `utils/color-names.js` and is re-exported below, so the palette, the store and the
// command all accept exactly the same colours.
export { isColorName };

/** The palette the project ships, so `/skins reset` can restore it. */
export const DEFAULT_CONVERSATION_COLORS = Object.freeze({ ...CONVERSATION_COLORS });

/** The palette in force right now, as a copy: the read side of the live object. */
export function activePalette() {
  return { ...CONVERSATION_COLORS };
}

/**
 * The presentation tokens in force right now, the selected band and the two prose
 * backgrounds included.
 *
 * The bands ride here (and not only in `PROSE_BACKGROUNDS`) because this is the read side
 * the command persists: `/skins save <name>` writes `{ ...activeTokens() }`, so a band a
 * user built by hand is only kept if the token set carries it.
 */
export function activeTokens() {
  return {
    ...THEME_TOKENS,
    selected: SLASH_COLORS.selected,
    selectedFg: SLASH_COLORS.selectedFg,
    userBg: PROSE_BACKGROUNDS.user,
    assistantBg: PROSE_BACKGROUNDS.assistant,
  };
}

/**
 * Move the live palette to `palette`'s colours, key by key.
 *
 * Only a key `CONVERSATION_COLORS` already holds and a value that is a blessed colour name
 * are taken, so a partial or malformed skin degrades to the colour it did not name instead
 * of painting a broken tag. Mutating in place — never rebinding — is what lets every
 * module that already imported the palette see the change.
 */
export function setPalette(palette = {}) {
  if (palette && typeof palette === 'object') {
    for (const [kind, color] of Object.entries(palette)) {
      if (Object.prototype.hasOwnProperty.call(CONVERSATION_COLORS, kind) && isColorName(color)) {
        CONVERSATION_COLORS[kind] = color.trim();
      }
    }
  }
  return activePalette();
}

/** Move the live presentation tokens, colour names and booleans alike. */
export function setTokens(tokens = {}) {
  if (tokens && typeof tokens === 'object') {
    for (const key of ['border', 'brand', 'hint']) {
      if (isColorName(tokens[key])) THEME_TOKENS[key] = tokens[key].trim();
    }
    for (const key of ['boldIntent', 'boldTracking']) {
      if (typeof tokens[key] === 'boolean') THEME_TOKENS[key] = tokens[key];
    }
    // `selected` is a **background** band, so it is checked against the background vocabulary
    // (`utils/color-names.js#BLESSED_BACKGROUNDS`) — the same set of names a foreground
    // takes, because blessed paints a bright background as well as a bright foreground.
    // `selectedFg` is the text *on* the band, so it is an ordinary foreground.
    if (isBackgroundColorName(tokens.selected)) SLASH_COLORS.selected = tokens.selected.trim();
    if (isColorName(tokens.selectedFg)) SLASH_COLORS.selectedFg = tokens.selectedFg.trim();
    // The two prose bands: a token name (`userBg`) maps to the role a band is painted from
    // (`user`), through the shared map in the leaf module. Mutating `PROSE_BACKGROUNDS` in
    // place is what makes the next paint of the transcript wear the new background instead
    // of the one it was banded with.
    for (const [key, role] of Object.entries(ROLE_OF_BAND_TOKEN)) {
      // A band is a background, so it takes the background vocabulary: the same names a
      // foreground takes, because blessed paints a bright background as well as a bright
      // foreground (`utils/color-names.js#BLESSED_BACKGROUNDS`).
      if (isBackgroundColorName(tokens[key])) PROSE_BACKGROUNDS[role] = tokens[key].trim();
    }
  }
  return activeTokens();
}

/**
 * Apply a whole skin (`utils/skins-store.js#normalizeSkin`): its palette and its tokens in
 * one call, which is exactly what `/skins <name>` does to a running session. Returns what
 * is now in force, so the command can report it.
 */
export function applySkin(skin = {}) {
  setPalette(skin?.palette);
  setTokens(skin);
  // The name travels with the colours: it is what a session save records and what a
  // resume reads back (`activeSkinName()`). A skin with no usable name leaves the
  // current one alone rather than clearing it.
  const name = typeof skin?.name === 'string' ? skin.name.trim() : '';
  if (name) setSkinName(name);
  return { palette: activePalette(), tokens: activeTokens(), name: activeSkinName() };
}

/** Restore the shipped palette and tokens (what `/skins reset` does). */
export function resetTheme() {
  for (const [kind, color] of Object.entries(DEFAULT_CONVERSATION_COLORS)) {
    CONVERSATION_COLORS[kind] = color;
  }
  setTokens({
    border: 'cyan', brand: 'bright-white', hint: 'grey',
    selected: 'blue', selectedFg: 'white', userBg: 'blue', assistantBg: 'red',
    boldIntent: true, boldTracking: true,
  });
  setSkinName(null);
  // The shipped look is also the *unbootstrapped* state: a reset means the startup path has
  // not chosen a project skin yet, so a later resume is licensed to restore its own again.
  clearSkinBootstrapped();
  return { palette: activePalette(), tokens: activeTokens(), name: null };
}
