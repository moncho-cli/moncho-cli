/**
 * The two **live** background bands around the sides of the dialogue
 * (`docs/interface/prose-bands`, `docs/interface/skins`).
 *
 * A leaf module on purpose (no imports, like `utils/color-names.js`): the band is painted
 * from `app/prose-band.js`, which sits under both the theme and the transcript view, so the
 * one object it reads must not drag either of them in. `app/theme-palette.js` re-exports
 * this object as part of the live theme state, and `setTokens()` mutates it **in place** —
 * that in-place mutation, not a rebind, is what lets every module that already imported the
 * band see a skin's colour without a re-import.
 *
 * The object used to be a frozen constant inside `app/prose-band.js`, and that was the
 * reported bug: every request in the log asked for a *background* ("user messages to be
 * green background", "the model prose in blue background"), there was no key for one, so the
 * model moved the nearest foreground, reported success, and the band behind every row stayed
 * exactly as it was. It is live state now, so `userBg=green` (or a model answer naming
 * `userBg`) reaches the screen.
 *
 * Both shipped values are the **dark** form of their colour: a band sits *under* the whole
 * foreground palette, so a bright background would swallow the rows painted on it. `blue` is
 * the one coloured band a terminal is certain to paint; `red` is the dark ANSI red
 * (`\u001b[41m`), which replaced the muddy dark yellow. The two must never be equal, or the
 * two sides of the dialogue become indistinguishable — which is the whole point of a band.
 */
export const PROSE_BACKGROUNDS = {
  /** the band behind the user's echoed prompt (`app/prose-band.js#bandColor`) */
  user: 'blue',
  /** the band behind the model's prose; the dark red, never the bright one */
  assistant: 'red',
};

/** The token name each role's band is persisted under (`utils/skins-store.js#PRESENTATION_KEYS`). */
export const BAND_TOKEN_OF = Object.freeze({ user: 'userBg', assistant: 'assistantBg' });

/** The role each band token moves, the other direction of `BAND_TOKEN_OF`. */
export const ROLE_OF_BAND_TOKEN = Object.freeze({ userBg: 'user', assistantBg: 'assistant' });
