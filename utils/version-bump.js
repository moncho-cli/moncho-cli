/**
 * How far a session moved the version, and how far it *had* to.
 *
 * `package.json#version` is the single source of the release tag
 * (`scripts/release.mjs` derives `v<version>` from it), which is what makes the
 * maintainer rule enforceable instead of a habit:
 *
 * > A session that changes behaviour bumps the version, and the bump matches the
 * > change — a breaking change is a major, a new behaviour a minor, a fix a patch.
 * > **One step is enough even when the session changed many things**: the bump marks
 * > the session, it does not measure it.
 *
 * The check is therefore loose in one direction and strict in the other. Any forward
 * step passes, however many changes the session carried; *no* step at all, or a step
 * backwards, does not. The recommended distance is reported beside the actual one, so
 * a maintainer can see when a single step understates the change — a note, not a
 * refusal, because refusing it would punish exactly the sessions the rule exists to
 * keep honest.
 *
 * Pure string arithmetic: no filesystem, no git, no clock. The caller supplies the two
 * versions (the committed one and the manifest one) and the kinds of change.
 */

/** The distances a bump can have, smallest first. `backwards` is not one of them. */
export const BUMP_DISTANCES = ['none', 'patch', 'minor', 'major'];

/** The change kinds a session reports, and the distance each one deserves. */
const CHANGE_DISTANCE = {
  breaking: 'major',
  removal: 'major',
  rename: 'major',
  feature: 'minor',
  behaviour: 'minor',
  fix: 'patch',
  refactor: 'patch',
  docs: 'patch',
  test: 'patch',
  chore: 'patch',
};

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A version as its three numbers, or `null` when the string is not a semver. */
export function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const match = SEMVER.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/**
 * The numeric mass of a version, for ordering two of them. A prerelease ranks with the
 * release it precedes.
 *
 * Exported because it is the ordering key of *any* question about two versions, not just
 * this rule's: `utils/session-compat.js` compares a session's pin with the running build
 * with the same arithmetic rather than deriving a second one.
 *
 * @param {string|{major: number, minor: number, patch: number}} value a version, or the parse of one
 * @returns {number|null} `null` when the value is not a semver
 */
export function semverRank(value) {
  const version = typeof value === 'string' ? parseSemver(value) : value;
  if (!version) return null;
  return version.major * 1_000_000 + version.minor * 1_000 + version.patch;
}

/**
 * The step between two versions.
 *
 * @returns {'none'|'patch'|'minor'|'major'|'backwards'|null} `null` when either
 *   version is not a semver. `backwards` is the one step a release never takes.
 */
export function bumpDistance(from, to) {
  const before = parseSemver(from);
  const after = parseSemver(to);
  if (!before || !after) return null;
  if (semverRank(after) === semverRank(before)) return 'none';
  if (semverRank(after) < semverRank(before)) return 'backwards';
  if (after.major !== before.major) return 'major';
  if (after.minor !== before.minor) return 'minor';
  return 'patch';
}

/** The version one step on from `version`, for the guidance a refusal hands over. */
export function nextVersion(version, distance = 'patch') {
  const parsed = parseSemver(version);
  if (!parsed) return null;
  if (distance === 'major') return `${parsed.major + 1}.0.0`;
  if (distance === 'minor') return `${parsed.major}.${parsed.minor + 1}.0`;
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

/**
 * The distance the reported kinds of change deserve: the largest one named.
 *
 * An unknown kind counts as a `patch` — the smallest forward step — because the rule
 * demands a step and the *recommendation* is only ever advice.
 */
export function classifyChange(kinds = []) {
  const list = Array.isArray(kinds) ? kinds : [kinds];
  let worst = 'none';
  for (const kind of list) {
    const distance = CHANGE_DISTANCE[String(kind).trim().toLowerCase()] ?? 'patch';
    if (BUMP_DISTANCES.indexOf(distance) > BUMP_DISTANCES.indexOf(worst)) worst = distance;
  }
  return worst;
}

/**
 * Decide whether a session moved the version the way the maintainer rule requires.
 *
 * @param {{from?: string|null, to?: string|null, kinds?: string[]}} plan `from` is the
 *   version the session started from (the committed manifest), `to` the one it left
 *   behind (the manifest on disk).
 * @returns {{ok: boolean, code: string, from: string|null, to: string|null,
 *   distance: string|null, recommended: string, understated?: boolean,
 *   message: string, guidance: string}}
 */
export function evaluateBump({ from, to, kinds = [] } = {}) {
  const recommended = classifyChange(kinds);
  const distance = bumpDistance(from, to);

  if (distance === null) {
    return {
      ok: false,
      code: 'VERSION_INVALID',
      from: from ?? null,
      to: to ?? null,
      distance: null,
      recommended,
      message: `${JSON.stringify(to ?? null)} is not a semver, so it cannot be compared with ${JSON.stringify(from ?? null)}.`,
      guidance: 'Both versions must be x.y.z; an optional -prerelease is allowed.',
    };
  }

  if (distance === 'none') {
    return {
      ok: false,
      code: 'VERSION_UNCHANGED',
      from,
      to,
      distance,
      recommended,
      message: `The session left the version at ${to}. A session that changes behaviour moves it.`,
      guidance: `Bump ${to} by one step (a minor is ${nextVersion(to, 'minor')}) and keep package-lock.json in step.`,
    };
  }

  if (distance === 'backwards') {
    return {
      ok: false,
      code: 'VERSION_BACKWARDS',
      from,
      to,
      distance,
      recommended,
      message: `The version moved backwards: ${from} -> ${to}. A published number is never reused.`,
      guidance: `Bump forward from ${from}, the version the last release carried.`,
    };
  }

  const understated = BUMP_DISTANCES.indexOf(distance) < BUMP_DISTANCES.indexOf(recommended);
  return {
    ok: true,
    code: 'VERSION_BUMPED',
    from,
    to,
    distance,
    recommended,
    understated,
    message: `${from} -> ${to} is a ${distance} step.`
      + (understated
        ? ` One step is enough even when the session changed many things (a ${recommended} was the closest match).`
        : ''),
    guidance: `The release is tagged v${to} when it is cut (scripts/release.mjs).`,
  };
}
