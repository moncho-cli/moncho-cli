import {
  readSkin, readActiveName, writeActiveName, skinPath, BACKGROUND_KEYS,
} from '../utils/skins-store.js';
import {
  applySkin, activeSkinName, markSkinBootstrapped, restoreSkinName, activePalette, activeTokens,
} from './theme.js';
import { readFileIfExists } from '../utils/file-io.js';
import { isBackgroundColorName } from '../utils/color-names.js';
import { logEvent } from '../utils/logger.js';
import { reducedBackgrounds, terminalColorCount } from './terminal-capability.js';

/**
 * Name the background tokens a **stored file** carries that blessed cannot paint, and the
 * ones the terminal will show as something other than what was asked for.
 *
 * Two different things can happen to a band, and they deserve different sentences:
 *
 *  - a name blessed cannot paint **at all** is degraded by the store to the shipped
 *    colour, so the symptom is silence — the band keeps the colour it already had and
 *    nothing on screen says why. Reading the raw file is the only place the refused name
 *    still exists, so it is named here.
 *  - a name the terminal paints, but **not in the form asked for** — a bright background
 *    on a terminal with fewer than sixteen colours — is honoured and shown as its base
 *    colour. That is not a failure, so it is recorded as what it is.
 */
function logUnpaintableBands(name, { dir = undefined } = {}) {
  if (!name) return;
  let raw = null;
  try {
    raw = JSON.parse(readFileIfExists(skinPath(name, { dir })) ?? 'null');
  } catch {
    return;
  }
  const refused = BACKGROUND_KEYS
    .filter((key) => raw?.[key] !== undefined && !isBackgroundColorName(raw[key]))
    .map((key) => ({ key, value: raw[key] }));
  if (refused.length) {
    logEvent('warn', 'skins', 'background colour refused; it would be printed literally', {
      name, refused, kept: { ...activeTokens() },
    });
  }
  const reduced = reducedBackgrounds(activeTokens(), BACKGROUND_KEYS);
  if (Object.keys(reduced).length) {
    logEvent('info', 'skins', 'background painted as the terminal allows', {
      name, terminal: terminalColorCount(), reduced,
    });
  }
}

/**
 * The project's skin, as the host wires it (`docs/interface/skins`).
 *
 * Three small pieces of startup and one per-command hook, kept out of `main.js` because
 * the wiring module is about the *session* and a look is a preference that outlives it.
 * The order below is the whole contract, and it is order-sensitive:
 *
 *  1. `applyProjectSkin()` runs **before the screen is built**, so the first frame —
 *     border, brand line, input hint — already wears the project's look;
 *  2. it then marks the bootstrap done, which is what licenses a *resume* to restore a
 *     session's own skin later. Restoring before that point would be painted over by
 *     step 1, so the resume would appear to do nothing.
 *
 * `skinOf` is the live reader the session recorder calls on **every** save, so the look a
 * conversation was held in is the one its record carries.
 */

/**
 * Apply the project's stored skin and license a later per-session restore.
 *
 * A missing or unreadable skin file is not an error: the built-in default is exactly what
 * a project with no skin looks like, so a corrupt file degrades to it rather than failing
 * startup.
 *
 * @returns {object|null} the skin applied, or null when the project has none
 */
export function applyProjectSkin({ dir = undefined } = {}) {
  let skin = null;
  try {
    skin = readSkin(readActiveName({ dir }), { dir });
  } catch (error) {
    // A corrupt `active.json` is not worth failing a session over.
    logEvent('warn', 'skins', 'the project skin could not be read; using the default', { error: error?.message });
  }
  if (skin) {
    logUnpaintableBands(skin.name, { dir });
    applySkin(skin);
  }
  markSkinBootstrapped();
  logEvent('info', 'skins', 'startup', { skin: skin?.name ?? null });
  return skin;
}

/** The skin in force, read live — the `skinOf` reader the recorder is built with. */
export function currentSkin() {
  return activeSkinName();
}

/**
 * The `onApply` hook `/skins` calls once it moved the palette.
 *
 * It remembers the applied skin as the **project's** (so the next launch opens in it) and
 * repaints the chrome, which is the link between a look and the session it is used in.
 * A skin with no name (the built-in default) is not written back.
 *
 * @param {object|null} skin the skin now in force
 * @param {{ repaint?: Function }} [hooks] the front end's repaint
 */
export function rememberAppliedSkin(skin, { repaint = null, dir = undefined } = {}) {
  if (skin?.name) {
    try {
      writeActiveName(skin.name, { dir });
    } catch (error) {
      logEvent('warn', 'skins', 'the project skin could not be remembered', { name: skin.name, error: error?.message });
    }
  }
  // The **live** profile is logged beside the name: a look that "saved but did not change"
  // is only diagnosable if the log says what is now actually in force — the palette, the
  // bands and the tokens — and not only which skin was chosen. `activeTokens()` carries the
  // two prose bands, so a request for a background is visible here too.
  logEvent('info', 'skins', 'project skin remembered', {
    skin: skin?.name ?? null,
    live: { palette: activePalette(), ...activeTokens() },
    repainted: typeof repaint === 'function',
  });
  if (typeof repaint === 'function') repaint();
}

/**
 * Restore the look a **resumed session** was held in.
 *
 * The recorded value is a **name**; the file behind it holds the colours, so both are
 * needed. A record written before the field existed carries no name and leaves the current
 * look alone, and a name whose file has since been deleted does the same rather than
 * inventing a palette.
 *
 * @param {string|null} name the skin name stored with the session
 * @param {{ repaint?: Function }} [hooks]
 * @returns {boolean} whether the look moved
 */
export function restoreSessionSkin(name, { repaint = null, dir = undefined } = {}) {
  // The file is read **first**: a name whose file has since been deleted must not rename the
  // look, because the recorder would then save a name with nothing behind it — the exact
  // broken link this feature exists to avoid.
  let skin = null;
  try {
    skin = readSkin(name, { dir });
  } catch (error) {
    logEvent('warn', 'skins', 'the session skin could not be read; keeping the current look', {
      name, error: error?.message,
    });
  }
  if (!skin) return false;
  // `restoreSkinName()` is the guard: it refuses before the startup bootstrap, so a resume
  // cannot be painted over by the project's skin.
  if (!restoreSkinName(name)) return false;
  logUnpaintableBands(name, { dir });
  applySkin(skin);
  logEvent('info', 'skins', 'session skin restored', {
    name,
    applied: true,
    repainted: typeof repaint === 'function',
    live: { palette: activePalette(), ...activeTokens() },
  });
  if (typeof repaint === 'function') repaint();
  return true;
}