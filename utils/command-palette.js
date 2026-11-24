/**
 * The `run_bash` palette, and how a configured one is resolved
 * (`docs/agent/command-sandbox`).
 *
 * The allow-list is a **default**, not a constant: `RUN_BASH_ALLOWED` names the binaries the
 * palette holds. This module is only the resolution rule, kept pure so it can be proved
 * without an environment, a sandbox or a spawn.
 *
 * The rule is deliberately the weakest kind of configuration, because the palette is the
 * most dangerous knob in the harness. Two properties carry it:
 *
 *  - **a value that parses to nothing is not an empty palette.** Empty, whitespace, or a
 *    string of separators is treated as *unset*, and the defaults stand. A harness that
 *    answered "no commands at all" to a typo would look like a broken sandbox rather than a
 *    configured one, and the difference between the two is not visible from the refusal.
 *  - **a name is a bare word.** A token with a slash, whitespace or a shell metacharacter is
 *    dropped rather than kept: the palette is matched against the *first token* of a command
 *    line, where a name like `../bin/sh` could never be matched anyway. Dropping it is the
 *    difference between a knob that does nothing and a knob that pretends to work.
 *
 * **This is not a security boundary.** It is a capability boundary at most. The agent runs
 * with its own uid's permissions in a workspace it is meant to change, and the fence that
 * matters is the container and the mount set (`docs/agent/host-fence`); the palette sits
 * inside that fence. Widening the palette widens what the agent can *conveniently* do, not
 * what it is *permitted* to do.
 */

/**
 * A usable binary name?
 *
 * Bare words only: letters, digits, and the punctuation real binaries have (`-`, `_`, `.`,
 * `+`). Everything else — a slash, a space, a metacharacter — is refused, because such a
 * token could never match the first token of a tokenised command line.
 */
function isPaletteWord(token) {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(token);
}

/**
 * The palette a run should use.
 *
 * @param {string|string[]|undefined|null} configured the `RUN_BASH_ALLOWED` value — a
 *   comma- or space-separated list, or an array
 * @param {string[]} defaults the built-in palette, used whenever the configured value is
 *   absent or parses to nothing
 * @returns {string[]} the palette, in the order given, without duplicates
 */
export function resolveCommandPalette(configured, defaults = []) {
  const fallback = (Array.isArray(defaults) ? defaults : [])
    .map((name) => String(name).trim())
    .filter(isPaletteWord);

  // An array is accepted as well as a string, so a caller can pass one without joining it:
  // the separator is a presentation detail of the environment variable.
  const raw = Array.isArray(configured)
    ? configured.map((item) => String(item))
    : String(configured ?? '').split(/[\s,]+/);

  const names = [];
  for (const item of raw) {
    const token = String(item).trim();
    if (!token) continue;
    if (!isPaletteWord(token)) continue;
    if (!names.includes(token)) names.push(token);
  }

  // Nothing usable was configured, which is *unset* — never an empty palette.
  return names.length > 0 ? names : fallback;
}

/**
 * Was a palette actually configured?
 *
 * Answered by comparing the resolved palette with the defaults, so the two questions a
 * caller has — "what are the names" and "did somebody set this" — cannot drift apart.
 */
export function paletteIsConfigured(configured, defaults = []) {
  const resolved = resolveCommandPalette(configured, defaults);
  const baseline = (Array.isArray(defaults) ? defaults : []).map((name) => String(name).trim());
  return resolved.length !== baseline.length
    || resolved.some((name, index) => name !== baseline[index]);
}
