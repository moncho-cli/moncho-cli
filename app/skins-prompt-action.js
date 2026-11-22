import {
  DEFAULT_SKIN, DEFAULT_SKIN_NAME, readSkin, saveSkin, writeActiveName, slugName, normalizeSkin,
} from '../utils/skins-store.js';
import { activePalette, activeTokens, applySkin } from './theme.js';
import { logEvent } from '../utils/logger.js';

/**
 * `/skins prompt <request>` — the natural-language half of the command
 * (`docs/interface/skins`).
 *
 * Kept out of `app/skins-command.js` because it is the one action that talks to a model,
 * waits on a modal and then has to decide *two* things (put the look on, and whether the
 * project adopts it), while every other action is a table lookup plus a write. The
 * command parses and routes; this module owns the subchat conversation.
 *
 * The rule that took a bug report to get right: **an applied skin is always written down.**
 * "Apply for this session" used to write nothing, so the session recorded a skin *name*
 * with no file behind it and a resume had nothing to put back — the look and the session
 * were never linked. A skin is a file (`agent/skins/<name>.json`); a look that exists only
 * in RAM cannot be re-read, listed, edited or restored. What `save` decides is narrower and
 * separate: whether the *project* adopts the skin as its default (`active.json`).
 */

/**
 * The look **on screen right now**, as the floor a model request is answered from.
 *
 * The file on disk is not enough: `/skins <name> intent=green` (no `save`) moves the screen
 * without writing anything, and `/skins customize` is meant to adjust *what the user is
 * looking at*. Sending the file's colours instead would let the model reason about a look
 * that is not the one in force — it could "keep everything it did not mention" by keeping
 * colours the user already changed away from. So the identity (the name) comes from the
 * active skin and every colour comes from the live palette and tokens, which is exactly the
 * pair `activePalette()`/`activeTokens()` read.
 *
 * @param {object|null} active the active skin read from its file, or null
 * @returns {object} a canonical skin wearing the live colours and the active name
 */
export function liveProfile(active = null) {
  const identity = active || { ...DEFAULT_SKIN };
  return normalizeSkin({
    ...identity,
    palette: { ...identity.palette, ...activePalette() },
    ...activeTokens(),
  });
}

/**
 * Run the prompt action.
 *
 * @param {object} ctx the command context (`skinSubchat`, `skinsDir`, `activeName`, `onApply`)
 * @param {{request: string}} parsed the parsed argument
 * @param {string} dir the skins directory
 * @param {Function} activeName the active-name reader the command built
 * @returns {Promise<object>} the command result
 */
export async function runSkinPrompt(ctx, parsed, dir, activeName) {
  if (!parsed.request) {
    return {
      ok: false,
      code: 'EMPTY_REQUEST',
      message: 'Say what the skin should be: /skins prompt a warm sunset palette.',
    };
  }
  if (typeof ctx.skinSubchat !== 'function') {
    return {
      ok: false,
      code: 'NO_SUBCHAT',
      message: 'This front end has no skin subchat; use /skins <name> or /skins <name> intent=bright-yellow save <name>.',
    };
  }

  // The proposal is *built on* the skin in force, so "make it warmer" keeps the rest of
  // the look instead of resetting every colour the request did not mention. "The skin in
  // force" is the live profile, not the file: an unsaved `/skins <name> token=…` moved the
  // screen, and the model has to be told what is really there.
  const base = liveProfile(readSkin(activeName(ctx), { dir }));
  logEvent('info', 'skins', 'proposal requested', { request: parsed.request, base: base.name });

  // The subchat answers a **choice** — `{ skin, save }` — because the modal offers
  // "Apply and save" beside "Apply for this session". A bare skin is still accepted, so a
  // host that answers the older shape keeps working.
  const choice = await ctx.skinSubchat(parsed.request, {
    base, dir, palette: activePalette(), tokens: activeTokens(),
  });
  const proposed = choice?.skin ?? choice ?? null;
  const save = Boolean(choice?.save);

  // A null answer covers two cases the user must be able to tell apart from "it worked":
  // a cancelled modal, and a model call that answered nothing usable. Both leave the look
  // alone, and both say so on screen — a silent no-op reads as a broken feature.
  if (!proposed) {
    logEvent('info', 'skins', 'no skin proposed; the look is unchanged', { request: parsed.request });
    return { ok: true, code: 'CANCELLED', message: 'No skin applied; the look is unchanged.' };
  }

  applySkin(proposed);
  logEvent('info', 'skins', 'applied the proposed skin', {
    name: proposed.name, palette: proposed.palette, save,
  });
  ctx.onApply?.(proposed);

  // The file is always written; only `save` makes it the project's default.
  let saved;
  try {
    saved = saveSkin({ ...proposed, name: proposed.name }, { dir });
    if (save) writeActiveName(saved.skin.name, { dir });
    logEvent('info', 'skins', 'saved the applied skin', {
      name: saved.skin.name, path: saved.path, projectDefault: save,
    });
  } catch (error) {
    // The look is on screen regardless: a write that fails is reported, never thrown.
    return {
      ok: false,
      code: 'SAVE_FAILED',
      skin: proposed,
      message: `Applied "${proposed.name}" for this session, but writing agent/skins/ failed: ${error.message}`,
    };
  }

  if (save) {
    return {
      ok: true,
      code: 'SAVED',
      skin: saved.skin,
      path: saved.path,
      message: `Applied the proposed skin "${saved.skin.name}" and saved it to ${saved.path}. This project now opens in it.`,
    };
  }
  return {
    ok: true,
    code: 'PROPOSED',
    skin: saved.skin,
    path: saved.path,
    message: `Applied the proposed skin "${saved.skin.name}" and kept it in ${saved.path}. Use /skins save ${saved.skin.name} to make it this project's default.`,
  };
}

/**
 * Run the customize action: `/skins customize <request>`.
 *
 * The same modal, the same one model call, one different question. `/skins prompt` asks
 * for a **new** look — the answer invents a name and the user settles it. Customize asks
 * the model to **adjust the look already in force**: the name is fixed, the box offers no
 * name field, and the answer is written straight over the active skin's own file. Nothing
 * new is created and nothing is renamed, so the project's default stays where it was.
 *
 * A request with no skin behind it is refused rather than guessed at: with no active file
 * there is nothing to update, and creating one would be `/skins prompt` wearing a
 * different name.
 *
 * @param {object} ctx the command context (`skinSubchat`, `skinsDir`, `activeName`, `onApply`)
 * @param {{request: string}} parsed the parsed argument
 * @param {string} dir the skins directory
 * @param {Function} activeName the active-name reader the command built
 * @returns {Promise<object>} the command result
 */
export async function runSkinCustomize(ctx, parsed, dir, activeName) {
  if (!parsed.request) {
    return {
      ok: false,
      code: 'EMPTY_REQUEST',
      message: 'Say what to change: /skins customize make the intent warmer.',
    };
  }
  if (typeof ctx.skinSubchat !== 'function') {
    return {
      ok: false,
      code: 'NO_SUBCHAT',
      message: 'This front end has no skin subchat; use /skins <name> intent=bright-yellow save <name>.',
    };
  }

  // The built-in default answers a name but has no file: `readSkin('default')` returns the
  // shipped palette, which cannot be written to disk. Customizing it would mean creating a
  // skin, which is the prompt command's job, so it is refused here by name.
  const name = slugName(activeName(ctx));
  const active = name && name !== DEFAULT_SKIN_NAME ? readSkin(name, { dir }) : null;
  if (!active) {
    return {
      ok: false,
      code: 'NO_ACTIVE_SKIN',
      message: 'There is no active skin to customize. Apply one first with /skins <name>, or propose a new one with /skins prompt <request>.',
    };
  }

  logEvent('info', 'skins', 'customize requested', {
    request: parsed.request, name: active.name, base: { palette: activePalette(), ...activeTokens() },
  });

  // The base the model is asked to adjust is the **live profile** — the colours on screen
  // right now — not the file. An unsaved `/skins <name> token=…` moved the screen, and a
  // request like "change the model prose to green" has to be answered from the look the user
  // is actually looking at, so the model changes only what was asked and keeps the rest.
  const base = liveProfile(active);

  // The choice shape is the same one the prompt path uses, so the modal stays one widget.
  // `editable: false` is what tells it the name is settled; `customize: true` swaps the
  // action list for the update-only one.
  const choice = await ctx.skinSubchat(parsed.request, {
    base, dir, palette: activePalette(), tokens: activeTokens(), customize: true, editable: false,
  });
  const updated = choice?.skin ?? choice ?? null;
  if (!updated) {
    logEvent('info', 'skins', 'customize cancelled; the look is unchanged', { name: active.name });
    return { ok: true, code: 'CANCELLED', message: 'No change applied; the look is unchanged.' };
  }

  // The name cannot move: a customize request updates the skin in force, and a rename would
  // leave the project's default pointing at a file that no longer exists.
  const skin = { ...updated, name: active.name };
  applySkin(skin);
  logEvent('info', 'skins', 'updated the active skin', { name: skin.name, palette: skin.palette });
  ctx.onApply?.(skin);

  let saved;
  try {
    saved = saveSkin(skin, { dir });
    logEvent('info', 'skins', 'saved the customized skin', { name: saved.skin.name, path: saved.path });
  } catch (error) {
    return {
      ok: false,
      code: 'SAVE_FAILED',
      skin,
      message: `Applied the update to "${skin.name}", but writing agent/skins/ failed: ${error.message}`,
    };
  }

  return {
    ok: true,
    code: 'CUSTOMIZED',
    skin: saved.skin,
    path: saved.path,
    message: `Updated the active skin "${saved.skin.name}" and saved it to ${saved.path}.`,
  };
}