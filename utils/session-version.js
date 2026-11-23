import pkg from '../package.json' with { type: 'json' };

/**
 * Which version is running, and which sessions it may open
 * (`docs/runtime/session-version`).
 *
 * A conversation is written by one build of the agent, and the two builds are not
 * interchangeable in practice: a newer runtime may read a record shape an older one
 * cannot, and a tool contract may have moved. So a session records **the version that
 * last wrote it**, and a runtime refuses to open a session that belongs to another one.
 *
 * The rule is deliberately the strict equality of two strings, not a comparison of
 * semvers. "Newer is fine" would let 0.29.0 open a session 0.28.0 wrote and then write
 * it back in a shape the older build cannot read — a refusal the user can act on beats a
 * file that only works in one direction.
 *
 * Pure and terminal-free: no `fs`, no screen. The running version arrives as a string
 * (from the runner or the environment) and every rule here is provable on two literals.
 *
 * @see docs/runtime/session-version
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
 * Whether `session` may be opened by `version`.
 *
 * Three answers, and the third is the one that keeps history usable:
 *  - no pin                          → allowed, and the next save stamps it;
 *  - the pin equals `version`        → allowed, this is the build that owns it;
 *  - anything else                   → refused.
 */
export function canOpenSession(session, version = runningVersion()) {
  const pinned = sessionVersion(session);
  return pinned === null || pinned === version;
}

/**
 * The refusal a locked session earns: what it is pinned to, and the exact command that
 * opens it.
 *
 * The command is the whole point of the message. A refusal that only says "wrong
 * version" leaves the user to find the version and invent the invocation; naming both
 * turns a dead end into one line to paste — and, once it opens, `/upgrade` is what moves
 * the conversation forward.
 */
export function sessionVersionRefusal(session, version = runningVersion()) {
  const pinned = sessionVersion(session) ?? 'an earlier version';
  const id = session?.id ?? 'this session';
  return [
    `Session ${id} was last written by Moncho ${pinned}; this is ${version}.`,
    'Open it with the version that owns it, then /upgrade to move it forward:',
    `  moncho-cli --version ${pinned}`,
  ].join('\n');
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