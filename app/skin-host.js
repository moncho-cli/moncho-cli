import { readSkin, readActiveName, writeActiveName } from '../utils/skins-store.js';
import { applySkin, activeSkinName, markSkinBootstrapped, restoreSkinName } from './theme.js';
import { logEvent } from '../utils/logger.js';

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
  if (skin) applySkin(skin);
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
  logEvent('info', 'skins', 'project skin remembered', { skin: skin?.name ?? null });
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
  applySkin(skin);
  logEvent('info', 'skins', 'session skin restored', { name, applied: true });
  if (typeof repaint === 'function') repaint();
  return true;
}