import {
  SKINS_DIR, DEFAULT_SKIN_NAME, DEFAULT_SKIN, BACKGROUND_KEYS,
  listSkins, readSkin, saveSkin, deleteSkin, writeActiveName, slugName,
} from '../utils/skins-store.js';
import { applySkin, activePalette, activeTokens, resetTheme, setPalette, setTokens } from './theme.js';
import { runSkinPrompt, runSkinCustomize } from './skins-prompt-action.js';
import {
  activeName, parseTokens, badValueMessage, parseSkinsArgs, formatSkinLines,
} from './skin-tokens.js';
import { logEvent } from '../utils/logger.js';
import { reducedBackgrounds, terminalColorCount } from './terminal-capability.js';

// The grammar, the token table and the listing live in `app/skin-tokens.js` (this module was
// over its line budget once it had to own the whole shape of a skin); re-exported here
// because this is the path every caller and every spec already uses.
export {
  activeName, parseTokens, badValueMessage, parseSkinsArgs, formatSkinLines,
  COLOR_TOKEN_KEYS, BOOLEAN_TOKEN_KEYS, SUGGESTED_COLORS,
} from './skin-tokens.js';

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
          logEvent('info', 'skins', 'saved the look on screen', {
            name: saved.skin.name,
            path: saved.path,
            // The live profile, bands included: a look that saved but did not seem to change
            // is diagnosable from the log alone, which is the whole point of logging the
            // palette AND the tokens here rather than only the name.
            live: { palette: activePalette(), ...activeTokens() },
          });
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

      const { palette, tokens, error, key, boolean, unknown, background } = parseTokens(parsed.pairs);
      if (error) {
        // A refused background is logged too: "I set userBg=orange and the band did not
        // move" is exactly the report the log has to be able to answer.
        if (background) {
          logEvent('warn', 'skins', 'background colour refused; it would be printed literally', {
            key, value: error, paintable: false,
          });
        }
        return { ok: false, code: 'BAD_VALUE', message: badValueMessage({ error, key, boolean, unknown, background }) };
      }

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
      // A background the terminal cannot show in the form it was asked for is named in the
      // log with **both** names: the request is honoured, but a terminal with fewer than
      // sixteen colours paints a bright background as its base colour. Saying so is the
      // difference between "the band did not move" and "the band moved, and your terminal
      // shows it as the base colour" (`app/terminal-capability.js`).
      const reduced = reducedBackgrounds(activeTokens(), BACKGROUND_KEYS);
      if (Object.keys(reduced).length) {
        logEvent('info', 'skins', 'background painted as the terminal allows', {
          terminal: terminalColorCount(),
          reduced,
        });
      }
      // `activeTokens()` carries the two prose bands (`userBg`/`assistantBg`), so the log
      // shows the backgrounds a request for one really set — the case that used to report
      // success while the band stayed as it was.
      logEvent('info', 'skins', `applied the skin "${name}"`, {
        palette: live.palette, tokens: activeTokens(), userBg: live.userBg, assistantBg: live.assistantBg,
      });
      ctx.onApply?.(live);

      if (parsed.action === 'apply-save') {
        // The written skin takes the name after `save` (that is what a new look is
        // called), and the project remembers it as active like any applied skin.
        const target = slugName(parsed.saveAs) || name;
        try {
          const saved = saveSkin({ ...live, name: target }, { dir });
          writeActiveName(saved.skin.name, { dir });
          // The write is recorded like the `/skins save` path's, with the live profile
          // (bands included): an `apply-save` that reported success while the screen stayed
          // put has to be diagnosable from the log, and the log would otherwise miss the
          // half of the command that touched the disk.
          logEvent('info', 'skins', 'saved the look on screen', {
            name: saved.skin.name,
            path: saved.path,
            live: { palette: activePalette(), ...activeTokens() },
          });
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
