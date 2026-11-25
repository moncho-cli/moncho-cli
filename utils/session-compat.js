import { parseSemver, semverRank } from './version-bump.js';

/**
 * Which sessions a build may open, and the migrations that carry the rest forward
 * (`docs/runtime/session-compat`).
 *
 * A session records the version that last wrote it (`docs/runtime/session-version`), and
 * the rule used to be strict equality of the two strings. Equality is right about the one
 * thing that must never happen — an **older** build opening bytes a newer one wrote, then
 * saving them in a shape the older build can no longer read — and wrong about almost
 * everything else: a patch release that touched a prompt or a doc refuses every session
 * on the disk for no reason at all. That is the friction this module exists to remove.
 *
 * The relaxation is a **compatibility era**, and the two rules keep the door shut between
 * them:
 *
 *  - a pin **newer** than the running build is refused, always. Ordering answers this and
 *    no table can override it: there is no un-migration, because the newer build has
 *    already read and written the conversation.
 *  - a pin **older** than the running build is openable while nothing between the two
 *    declares a break. That is the whole change: releases that did not break
 *    compatibility stop costing the user their history.
 *
 * Everything else follows from the break list below. A break is a release that really did
 * make older bytes unreadable, and it carries the function that crosses it — a pure
 * `record -> record` migration, so an "incompatible" session becomes an *upgradeable* one
 * wherever a migration exists and falls back to the refusal of yesterday where it does
 * not.
 *
 * Pure and terminal-free, like the pin it extends: no `fs`, no screen, no clock. Every
 * rule here is provable on two literals.
 *
 * @see docs/runtime/session-compat
 */

/** The era every version belongs to before the first break: there is always one. */
export const FIRST_ERA = 1;

/**
 * The releases that broke compatibility, **oldest first**, and how to cross each one.
 *
 * An entry is added in the session that makes a record, tool or prompt contract change
 * that a previous build can no longer read — never for a fix, a doc or a new feature:
 * declaring a break costs a migration and refuses the sessions that cannot take it, so
 * it is worth three lines of thought before it is worth one entry.
 *
 * ```js
 * { version: '0.40.0', note: 'the stamps moved beside the chunks', migrate: 'stampsBecomeAList' }
 * ```
 *
 * **Append-only, and the order is the meaning.** An entry's `version` is the release the
 * break landed in: a session written by that release is already in the new era, which is
 * what makes `compatEra()` a count of the entries at or below a version rather than a
 * search for one. `migrate` names a function in `MIGRATIONS`, or is `null` for a break
 * nobody has written a migration for — in which case the sessions it stranded are refused
 * with the way in, exactly as they were before this module existed.
 *
 * Empty on purpose: with nothing declared, every session on the disk opens again in the
 * build that un-strands it, and the list starts recording breaks from here on.
 */
export const COMPAT_BREAKS = [];

/**
 * The migrations a break may name, by name, so a break stays data.
 *
 * A migration is a **pure `record -> record`**: it receives the parsed record as it was
 * written and returns the record as this era wants it. No filesystem, no clock, no
 * network — the caller writes the result, stamps the pin and records the audit line
 * (`upgradedPin()`), because those are the caller's jobs and a migration that also wrote
 * to disk could not be proved on a literal.
 *
 * A migration must be tolerant of a record that lacks the field it is fixing: it may have
 * been written many releases before the break, or may never have carried that field at
 * all. Answering the record unchanged is a valid migration; throwing is not.
 */
export const MIGRATIONS = {};

/**
 * The problems a break list has, as prose, or an empty array when it is sound.
 *
 * The rule this checks is the one that cannot be repaired after the fact: the list is
 * **append-only and ascending**, because the era is a count of entries below a version.
 * A break inserted in the middle of the list, or moved backwards, silently re-labels every
 * session on the disk — so this is asserted by the tests rather than trusted to review.
 *
 * @returns {string[]} one line per problem
 */
export function validateCompatBreaks(breaks = COMPAT_BREAKS, { migrations = MIGRATIONS } = {}) {
  const problems = [];
  if (!Array.isArray(breaks)) return ['the break list is not an array'];

  let previous = null;
  const seen = new Set();
  for (const [index, entry] of breaks.entries()) {
    const where = `break ${index + 1}`;
    if (!entry || typeof entry !== 'object') { problems.push(`${where} is not an object`); continue; }

    const rank = semverRank(entry.version);
    if (rank === null) problems.push(`${where} does not name a semver version`);
    else {
      if (seen.has(entry.version)) problems.push(`${where} repeats ${entry.version}`);
      seen.add(entry.version);
      if (previous !== null && rank <= previous) {
        problems.push(`${where} (${entry.version}) is not after the one before it: the list is append-only`);
      }
      previous = rank;
    }

    if (entry.migrate != null) {
      if (typeof entry.migrate !== 'string') problems.push(`${where} names a migration that is not a name`);
      else if (typeof migrations[entry.migrate] !== 'function') problems.push(`${where} names the unknown migration "${entry.migrate}"`);
    }
  }
  return problems;
}

/**
 * The era a version belongs to: one, plus every break at or below it.
 *
 * A break is *landed* at its version, not before it, so the release that broke
 * compatibility is already in the new era — the count is therefore inclusive of the
 * version being asked about.
 *
 * A junk table dates nothing rather than throwing: the era of a version must answer the
 * same way whether the caller passed a real list or an accident.
 *
 * @param {string} version a semver
 * @returns {number|null} the era, or `null` when the string is not a semver
 */
export function compatEra(version, breaks = COMPAT_BREAKS) {
  const rank = semverRank(version);
  if (rank === null) return null;
  if (!Array.isArray(breaks)) return null;
  return FIRST_ERA + breaks.filter((entry) => {
    const at = semverRank(entry?.version);
    return at !== null && at <= rank;
  }).length;
}

/**
 * The breaks a session pinned at `from` must cross to be read by `to`, in order.
 *
 * Strictly after `from` and at or before `to`: the break landed in a release *after* the
 * one that wrote the session, and `to` itself is included because a build that carries the
 * break can read the new shape but not the old. The list is empty exactly when the two
 * versions are in the same era — which is what `compatEra()` counts, stated the other way
 * round.
 *
 * @returns {object[]} the break entries, oldest first; `[]` when none stands between them
 */
export function compatEraBreaks(from, to, breaks = COMPAT_BREAKS) {
  const after = semverRank(from);
  const upto = semverRank(to);
  if (after === null || upto === null || upto < after) return [];
  if (!Array.isArray(breaks)) return [];
  return breaks
    .filter((entry) => {
      const at = semverRank(entry?.version);
      return at !== null && at > after && at <= upto;
    })
    .sort((a, b) => semverRank(a.version) - semverRank(b.version));
}

/**
 * The whole decision, as three answers rather than two.
 *
 * `canOpenSession()` reads this and asks its one question; the gate reads it too, but it
 * needs the middle answer as well — a session that must be *migrated* opens only after the
 * record has been carried forward, and a refusal that means "a migration is missing" is a
 * different sentence from "another build wrote these bytes".
 *
 * | The pin | Answer | Why |
 * | --- | --- | --- |
 * | none | `open` | Nobody has claimed it; the next save stamps it |
 * | equals the running version | `open` | This is the build that owns it |
 * | **newer** than the running version | `refuse` | The one-way door: the newer build already wrote these bytes |
 * | older, every step declared | `migrate` | Older bytes the record can be carried forward into |
 * | older, no break between them | `open` | The releases did not break compatibility |
 * | older, a break with no migration | `refuse` | The refusal of yesterday: nothing can carry those bytes forward |
 * | not a semver | `refuse` | Ordering is the rule, so a version nobody can order is not assumed to be fine |
 *
 * @param {string|null} pinned the version the session claims, or `null` for no claim
 * @param {string} version the running version
 * @param {{breaks?: object[]}} [options] the break list under test; the shipped one by default
 * @param {object} [migrations] the name -> function table a break resolves against
 * @returns {{verdict: 'open'|'migrate'|'refuse', reason: string, steps: object[]}}
 *   `reason` names the branch for the caller's message, never for comparison
 */
export function compatVerdict(pinned, version, { breaks = COMPAT_BREAKS } = {}, migrations = MIGRATIONS) {
  if (pinned === null || pinned === undefined || pinned === '') {
    return { verdict: 'open', reason: 'unpinned', steps: [] };
  }
  if (pinned === version) return { verdict: 'open', reason: 'same-version', steps: [] };

  const from = semverRank(pinned);
  const to = semverRank(version);
  // Both versions must be orderable before ordering can be the rule. A pin that is not a
  // semver is not "probably fine": nothing here can say which side of the door it is on.
  if (from === null || to === null) return { verdict: 'refuse', reason: 'unparseable', steps: [] };
  if (from > to) return { verdict: 'refuse', reason: 'newer', steps: [] };

  const steps = compatEraBreaks(pinned, version, breaks);
  if (steps.length === 0) return { verdict: 'open', reason: 'same-era', steps: [] };
  // A break with no migration is the refusal of yesterday, and it is told apart from
  // "another build wrote these bytes": the user's way out is a different command.
  const unmigratable = steps.some(
    (step) => step?.migrate == null || typeof migrations[step.migrate] !== 'function',
  );
  if (unmigratable) return { verdict: 'refuse', reason: 'unmigratable', steps };
  return { verdict: 'migrate', reason: 'older-era', steps };
}

/**
 * Run the migrations a verdict asked for, in order, and say what could not run.
 *
 * All-or-nothing: a step whose migration is missing or throws stops the walk and answers
 * `ok: false` with the step that blocked it, because a record carried *half* way forward
 * is worse than one left alone — it claims an era it does not have. The record it returns
 * is the input when nothing ran, which is what makes a failed migration safe to ignore.
 *
 * The pin is deliberately not touched: rewriting the claim is the caller's write, together
 * with the audit line, and keeping it out of here is what leaves this function provable on
 * a literal.
 *
 * @param {object} record the record as it was written, parsed
 * @param {object[]} steps the `steps` a `migrate` verdict named
 * @returns {{ok: boolean, record: object, applied: string[], blocked: object|null, error: Error|null}}
 */
export function migrateRecord(record, steps = [], { migrations = MIGRATIONS } = {}) {
  let current = record;
  const applied = [];

  for (const step of steps) {
    const name = step?.migrate ?? null;
    const migrate = name === null ? null : migrations[name];
    if (typeof migrate !== 'function') {
      return { ok: false, record: current, applied, blocked: step ?? null, error: null };
    }
    try {
      current = migrate(current);
    } catch (error) {
      return { ok: false, record: current, applied, blocked: step, error };
    }
    applied.push(name);
  }

  return { ok: true, record: current, applied, blocked: null, error: null };
}

export { parseSemver };
