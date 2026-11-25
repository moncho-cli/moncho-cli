import pkg from '../package.json' with { type: 'json' };
import { compatVerdict } from './session-compat.js';

/**
 * Which version is running, and which sessions it may open
 * (`docs/runtime/session-version`).
 *
 * A conversation is written by one build of the agent. Two builds are not interchangeable
 * in every direction: a newer runtime may read a record shape an older one cannot, and a
 * tool contract may have moved. So a session records **the version that last wrote it**,
 * and the pin is judged by **compatibility era** rather than by equality of the strings
 * (`utils/session-compat.js`, `docs/runtime/session-compat`).
 *
 * The door stays one-way, because that is the part that matters: a pin **newer** than the
 * running build is refused always — there is no un-migration, the newer build has already
 * written these bytes. What equality got wrong is every other case: a patch release that
 * touched a prompt or a doc refused the whole history on the disk for nothing. An **older**
 * pin now opens while nothing between the two versions declares a break, and is carried
 * forward by a declared migration where one exists — falling back to the refusal of
 * yesterday where it does not.
 *
 * Pure and terminal-free: no `fs`, no screen. The running version arrives as a string
 * (from the runner or the environment) and every rule here is provable on two literals.
 *
 * @see docs/runtime/session-version
 * @see docs/runtime/session-compat
 */

/** The version this build declares, from the one manifest that owns it. */
export const DECLARED_VERSION = (() => {
  const raw = typeof pkg?.version === 'string' ? pkg.version.trim() : '';
  return raw || '0.0.0';
})();

/** The environment variable the runner uses to say which payload it mounted. */
export const VERSION_ENV = 'MONCHO_VERSION';

/** The environment variable the runner uses to say the newest version it has installed. */
export const LATEST_VERSION_ENV = 'MONCHO_LATEST_VERSION';

/**
 * The version this process is running.
 *
 * The runner knows the truth — it is the thing that chose which installed payload to
 * mount — so it passes `MONCHO_VERSION` and that wins. A checkout run through
 * `./start.sh` has no runner, and falls back to the manifest, which is the version that
 * checkout actually is.
 */
export function runningVersion(env = process.env) {
  const fromEnv = String(env?.[VERSION_ENV] ?? '').trim();
  return fromEnv || DECLARED_VERSION;
}

/**
 * The newest version installed on this machine, as the runner reports it.
 *
 * `/upgrade` targets **this**, not the running version, and the distinction is the whole
 * command: a session is upgraded by *starting the version that owns it* — so the running
 * build is the old one by definition, and "upgrade to what I am running" would be a
 * no-op that could never move anything forward. The runner knows what else is installed
 * and passes it here; a checkout run through `./start.sh` has no runner, so the manifest
 * is the newest there is.
 */
export function latestVersion(env = process.env) {
  const fromEnv = String(env?.[LATEST_VERSION_ENV] ?? '').trim();
  return fromEnv || DECLARED_VERSION;
}

/**
 * The version a session record claims, or `null` when it makes no claim.
 *
 * `null` is its own answer, not a wildcard: a record written before the field existed
 * carries no pin, and every runtime may open it (nobody has claimed it yet — the first
 * save will). Treating a missing pin as "some unknown other version" would strand every
 * session already on disk at every upgrade, which is the one thing the rule must not do.
 */
export function sessionVersion(session) {
  const raw = session?.monchoVersion;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/**
 * The compatibility verdict for one session, as `compatVerdict()` decides it.
 *
 * The gate needs the distinction `canOpenSession()` throws away: a `migrate` verdict opens
 * only *after* the record has been carried forward, while a `refuse` never opens. Both the
 * session file and the version to judge it against are already normalised here, so the
 * caller never has to know which field the pin lives in.
 *
 * @param {object} session a record, a summary from `listSessions()` or a live recorder
 * @param {string} [version] the running version
 * @param {{breaks?: object[], migrations?: object}} [options] the break list and the
 *   migration table under test; the shipped ones by default
 */
export function sessionVerdict(session, version = runningVersion(), options = {}) {
  return compatVerdict(sessionVersion(session), version, options, options.migrations);
}

/**
 * Whether `session` may be opened by `version`, migrations included.
 *
 * The pin earns one of three answers, and the middle one is what keeps history usable:
 *  - no pin, or the pin equals `version` → allowed, this build owns it;
 *  - older, nothing between them broke    → allowed, and the next save re-stamps it;
 *  - older, a declared break with its migration → allowed *once carried forward*,
 *    which the gate does before it hands the chunks over;
 *  - newer, or older across a break nobody can cross → refused.
 *
 * Answering `true` for the migratable case is deliberate: the bytes are this build's to
 * read, once the migration has run. The alternative — refusing until something else
 * migrates — would put the same decision in two places.
 */
export function canOpenSession(session, version = runningVersion(), options = {}) {
  return sessionVerdict(session, version, options).verdict !== 'refuse';
}

/**
 * The refusal a locked session earns: what it is pinned to, and the exact command that
 * opens it.
 *
 * The command is the whole point of the message. A refusal that only says "wrong
 * version" leaves the user to find the version and invent the invocation; naming both
 * turns a dead end into one line to paste — and, once it opens, `/upgrade` is what moves
 * the conversation forward.
 *
 * A pin **newer** than this build and a pin stranded across a break nobody has written a
 * migration for are different dead ends, so they get different sentences: the first is a
 * build this one cannot be, the second is a change this one cannot make. The way in is the
 * same command in both cases, because in both the version that owns the bytes is where the
 * work has to start.
 */
export function sessionVersionRefusal(session, version = runningVersion(), options = {}) {
  const pinned = sessionVersion(session) ?? 'an earlier version';
  const id = session?.id ?? 'this session';
  const { reason, steps = [] } = sessionVerdict(session, version, options);

  const cause = reason === 'newer'
    ? `Session ${id} was last written by Moncho ${pinned}, which is newer than this ${version}: a build cannot read bytes a later one wrote.`
    : reason === 'unmigratable'
      ? `Session ${id} was last written by Moncho ${pinned}, and ${breaksSentence(steps)} this ${version} cannot cross.`
      : `Session ${id} was last written by Moncho ${pinned}; this is ${version}.`;

  return [
    cause,
    'Open it with the version that owns it, then /upgrade to move it forward:',
    `  moncho-cli --version ${pinned}`,
  ].join('\n');
}

/** The breaks standing in the way, named once, for the refusal that has no migration. */
function breaksSentence(steps) {
  const versions = steps.map((step) => step?.version).filter((one) => typeof one === 'string');
  if (versions.length === 0) return 'a change declared between them leaves these bytes unreadable, and';
  if (versions.length === 1) return `the break declared in ${versions[0]} is one`;
  return `the breaks declared in ${versions.join(', ')} are ones`;
}

/**
 * The pin an upgraded session carries, and the audit line that says where it came from.
 *
 * An upgrade is a **rewrite of the claim**, not a bypass of the check: the session now
 * belongs to the new version, so the old one refuses it afterwards. That is why there is
 * no downgrade — the conversation has already been read and written by the newer build.
 */
export function upgradedPin(previous, version = runningVersion(), at = new Date()) {
  return {
    monchoVersion: version,
    upgradedFrom: typeof previous === 'string' && previous.trim() ? previous.trim() : null,
    upgradedAt: (at instanceof Date ? at : new Date(at)).toISOString(),
  };
}