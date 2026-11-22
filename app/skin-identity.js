/**
 * The **identity of the look in force** (`docs/interface/skins`): which skin is on, and
 * whether the project's startup skin has been applied yet.
 *
 * Split out of `app/theme-palette.js`, which owns the *colours*, because neither fact is a
 * colour: two different skins can share every value, so "which skin is on" has to be
 * remembered rather than inferred, and the bootstrap flag is about *startup order* rather
 * than about what anything looks like. Both are read on a session save
 * (`docs/runtime/session-store`) and on a resume, and a leaf module (no imports) keeps that
 * read away from the render path.
 */

/**
 * The name of the skin in force, or `null` before any skin was chosen.
 *
 * `applySkin()` sets it, `resetTheme()` clears it. It is deliberately **not** part of
 * `CONVERSATION_COLORS` (`app/theme-palette.js`): a name is not a colour, and the palette is
 * what gets copied for painting.
 */
let currentSkinName = null;

/** The name of the skin in force, or null while the shipped default is on. */
export function activeSkinName() {
  return currentSkinName;
}

/** Set the name of the skin in force (used by `applySkin()`/`restoreSkinName()`). */
export function setSkinName(name) {
  currentSkinName = typeof name === 'string' && name ? name : null;
  return currentSkinName;
}

/**
 * Whether the project's saved skin has been bootstrapped yet.
 *
 * The host applies the project's active skin **once**, before the screen is built, and a
 * resumed session then restores *its own* skin. Without this flag the later restore would
 * paint the session's skin and, two lines later, the startup path would paint the project's
 * over it, so the resume would appear to do nothing.
 */
let bootstrapped = false;

/** Mark the startup skin as applied, so a resume may restore a session's own skin. */
export function markSkinBootstrapped() {
  bootstrapped = true;
  return bootstrapped;
}

/** True once the project's skin has been applied for this process. */
export function isSkinBootstrapped() {
  return bootstrapped;
}

/** Clear the bootstrap mark (what `resetTheme()` does). */
export function clearSkinBootstrapped() {
  bootstrapped = false;
  return bootstrapped;
}

/**
 * Restore the look a **resumed session** was held in.
 *
 * Deliberately refused before the startup skin was applied: at that point the startup path
 * has not run yet and would overwrite whatever this set. `name` may be null — a session file
 * written before the field existed carries no skin and must leave the look alone rather than
 * reset it.
 *
 * @param {string|null} name the skin name the session recorded
 * @returns {boolean} whether the look moved
 */
export function restoreSkinName(name) {
  if (!bootstrapped) return false;
  if (typeof name !== 'string' || !name) return false;
  currentSkinName = name;
  return true;
}
