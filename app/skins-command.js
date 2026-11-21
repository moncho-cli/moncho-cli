import {
  SKINS_DIR, DEFAULT_SKIN_NAME, DEFAULT_SKIN, PALETTE_KEYS, PRESENTATION_KEYS,
  listSkins, readSkin, saveSkin, deleteSkin, readActiveName, writeActiveName, slugName, isColorName,
} from '../utils/skins-store.js';
import { applySkin, activePalette, activeTokens, resetTheme, setPalette, setTokens } from './theme.js';
import { runSkinPrompt, runSkinCustomize } from './skins-prompt-action.js';
import { logEvent } from '../utils/logger.js';

/**
 * `/skins` — manage the project's look: the conversation palette and the hand-picked
 * presentation tokens (the border, the brand line, the input hint, the two bolds).
 * A **skin** is one JSON file under `agent/skins/` (`utils/skins-store.js`), so the
 * look of a project travels with the project and never with the session.
 *
 * Seven shapes are accepted, and nothing else:
 *
 *  - `/skins` (or `/skins list`) — list the project's skins, the active one flagged;
 *  - `/skins <name>` — apply a skin to the running session at once (the palette is
 *    live, `app/theme.js#applySkin`), and remember it as the project's active one;
 *  - `/skins save <name>` — save *what is on screen now* as a skin, so a look built
 *    by hand through `/skins` arguments is written down; the saved skin is then put
 *    on and remembered as the project's, so the screen changes at once;
 *  - `/skins <name> <token>=<value>… [save [<name>]]` — build a look from the skin
 *    `<name>` (or from what is on screen when `<name>` is new), set individual
 *    tokens and apply it — writing it down when `save` is named, e.g.
 *    `/skins warm intent=bright-yellow user=cyan save warm`;
 *  - `/skins reset` — back to the shipped default;
 *  - `/skins prompt <request>` — hand a natural-language request to the **modal
 *    subchat** (`app/skin-modal.js`), which proposes a skin for the user to confirm;
 *  - `/skins customize <request>` — the same subchat, asked to *update the active skin*
 *    in place instead of proposing a new one.
 *
 * The modal subchat is reached through `ctx.skinSubchat`, a host-provided function;
 * when the front end has none (the line CLI, the tests) `/skins prompt` refuses with
 * its own code and changes nothing.
 *
 * Like every command it returns a plain result object instead of printing, so the TUI
 * and the line CLI report it identically (`docs/interface/commands`).
 */

/** Where a skin's own name goes when it is not given: the persisted active skin. */
function activeName(ctx) {
  return slugName(ctx.activeName) || readActiveName({ dir: ctx.skinsDir });
}

/** The `tokens=` arguments of the command, or a refusal naming the bad one. */
function parseTokens(pairs = {}) {
  const palette = {};
  const tokens = {};
  for (const [key, value] of Object.entries(pairs)) {
    const raw = String(value ?? '').trim();
    if (PALETTE_KEYS.includes(key)) {
      if (!isColorName(raw)) return { error: raw, key };
      palette[key] = raw;
      continue;
    }
    if (['border', 'brand', 'hint', 'selected', 'selectedFg'].includes(key)) {
      if (!isColorName(raw)) return { error: raw, key };
      tokens[key] = raw;
      continue;
    }
    if (['boldIntent', 'boldTracking'].includes(key)) {
      if (raw !== 'true' && raw !== 'false') return { error: raw, key, boolean: true };
      tokens[key] = raw === 'true';
      continue;
    }
    return { error: key, key, unknown: true };
  }
  return { palette, tokens };
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
function badValueMessage({ error, key, boolean, unknown }) {
  if (unknown) return `"${error}" is not a skin token. The colours are user, tool, intent, context, error, notice, tracking, refusal; the look is border, brand, hint, selected, selectedFg, boldIntent, boldTracking.`;
  if (boolean) return `"${key}=${error}" needs true or false.`;
  return `"${error}" is not a colour this terminal can paint (${key}=${error}). Use a name like ${SUGGESTED_COLORS.join(', ')}.`;
}

/** A few names from each end of the vocabulary, short enough to read in one line. */
const SUGGESTED_COLORS = ['bright-blue', 'cyan', 'grey', 'bright-red', 'white'];

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

/** `/skins [list|reset|<name>|save <name>|prompt <request>]` — the project's look. */
export function skinsCommand() {
  return {
    name: 'skins',
    description: 'manage the project\'s colour palette and presentation (/skins prompt <request> for a new skin, /skins customize <request> to adjust the active one)',
    async run(ctx = {}) {
      const dir = ctx.skinsDir || SKINS_DIR;
      const parsed = parseSkinsArgs(ctx.arg);
      // One info line per `/skins`, so the operational log records what the user asked
      // for and what happened. A look that "did not change" is exactly the report the
      // log has to be able to answer, and the log outlives the session.
      logEvent('info', 'skins', `command /skins ${parsed.action}`, { arg: ctx.arg ?? '', dir });

      if (parsed.action === 'list') {
        const skins = listSkins({ dir });
        const current = activeName(ctx);
        const lines = [];
        for (const skin of skins) {
          if (skin.error) { lines.push(`${skin.name} — unreadable: ${skin.error}`); continue; }
          lines.push(...formatSkinLines(skin, { active: skin.name === current }));
        }
        logEvent('info', 'skins', 'listed skins', { dir, count: skins.length, active: current });
        return { ok: true, code: 'LISTED', skins, active: current, lines };
      }

      if (parsed.action === 'reset') {
        resetTheme();
        writeActiveName(DEFAULT_SKIN_NAME, { dir });
        logEvent('info', 'skins', 'reset to the shipped default', { dir });
        ctx.onApply?.(DEFAULT_SKIN);
        return {
          ok: true,
          code: 'RESET',
          skin: DEFAULT_SKIN,
          message: 'Back to the shipped default skin.',
          lines: formatSkinLines(DEFAULT_SKIN, { active: true }),
        };
      }

      if (parsed.action === 'prompt') {
        // The one action that talks to a model; the whole conversation lives in
        // `app/skins-prompt-action.js` so this module stays a router.
        return runSkinPrompt(ctx, parsed, dir, activeName);
      }

      if (parsed.action === 'customize') {
        // The same subchat, asked to update the active skin instead of proposing a new one.
        return runSkinCustomize(ctx, parsed, dir, activeName);
      }

      if (parsed.action === 'save') {
        const name = slugName(parsed.name);
        if (!name) return { ok: false, code: 'BAD_NAME', message: 'Give the skin a name: /skins save <name>.' };
        try {
          const saved = saveSkin({ name, palette: activePalette(), ...activeTokens() }, { dir });
          // A saved skin is the look the user just chose, so it becomes the project's
          // active one and goes on screen at once. Writing the file alone left the project
          // pointing at the previous skin and the screen unchanged — "it saved but nothing
          // changed". `applySkin()` records the name the session save reads, `writeActiveName()`
          // is what the next launch opens in, and `onApply` repaints the chrome.
          applySkin(saved.skin);
          writeActiveName(saved.skin.name, { dir });
          ctx.onApply?.(saved.skin);
          logEvent('info', 'skins', 'saved the look on screen', { name: saved.skin.name, path: saved.path });
          return { ok: true, code: 'SAVED', path: saved.path, skin: saved.skin, message: `Saved "${saved.skin.name}" to ${saved.path} and put it on.` };
        } catch (error) {
          return { ok: false, code: 'SAVE_FAILED', message: error.message };
        }
      }

      if (parsed.action === 'unknown') {
        return { ok: false, code: 'UNKNOWN_ARG', message: `"${parsed.token}" is not a token. Use key=value, /skins save <name>, /skins reset or /skins prompt <request>.` };
      }

      // apply, and apply-save: a name is always required.
      const name = slugName(parsed.name);
      if (!name) return { ok: false, code: 'BAD_NAME', message: 'Name the skin: /skins <name>, /skins save <name> or /skins list.' };

      const { palette, tokens, error, key, boolean, unknown } = parseTokens(parsed.pairs);
      if (error) return { ok: false, code: 'BAD_VALUE', message: badValueMessage({ error, key, boolean, unknown }) };

      const known = readSkin(name, { dir });
      const edits = Object.keys(palette).length + Object.keys(tokens).length;
      // A name that does not exist is only usable as the *subject of a change*: a bare
      // `/skins ghost` is a typo worth naming, while `/skins warm …` builds a new look
      // from whatever is on screen.
      if (!known && edits === 0) {
        return { ok: false, code: 'UNKNOWN_SKIN', message: `No skin named "${name}". /skins lists the ones there are.` };
      }

      // The base is applied first when it exists, then any explicit tokens override it,
      // so `/skins warm intent=bright-yellow` reads as "the warm skin, with the intent moved".
      if (known) applySkin(known);
      if (Object.keys(palette).length) setPalette(palette);
      if (Object.keys(tokens).length) setTokens(tokens);
      const live = { name, palette: activePalette(), ...activeTokens() };
      logEvent('info', 'skins', `applied the skin "${name}"`, { palette: live.palette, tokens: activeTokens() });
      ctx.onApply?.(live);

      if (parsed.action === 'apply-save') {
        // The written skin takes the name after `save` (that is what a new look is
        // called), and the project remembers it as active like any applied skin.
        const target = slugName(parsed.saveAs) || name;
        try {
          const saved = saveSkin({ ...live, name: target }, { dir });
          writeActiveName(saved.skin.name, { dir });
          return { ok: true, code: 'SAVED', path: saved.path, skin: saved.skin, message: `Saved "${saved.skin.name}" to ${saved.path} and put it on.` };
        } catch (error) {
          return { ok: false, code: 'SAVE_FAILED', message: error.message };
        }
      }

      writeActiveName(name, { dir });
      return {
        ok: true,
        code: 'APPLIED',
        // A name that does not exist yet is the *subject of a change*, not a file: the
        // look on screen is the live one, and `known` is null. Reading `known.name` here
        // crashed `/skins warm intent=bright-yellow` — building a new look without `save`.
        skin: live,
        message: `Skin "${name}" is on.`,
        lines: formatSkinLines(live, { active: true }),
      };
    },
  };
}

/** Delete one skin by name (kept here so a caller need not import the store directly). */
export function removeSkin(name, { dir = SKINS_DIR } = {}) {
  return deleteSkin(name, { dir });
}
