import { HOST_FENCE } from '../config/constants.js';

/**
 * The fence around the paths a **host** executes, not just reads.
 *
 * The path sandbox (`utils/path-safety.js`) keeps a tool inside the project tree. That is
 * the right rule for the project's own files and the wrong one for a handful of paths
 * whose *content* the host runs as the user's own shell:
 *
 *  - `.git/hooks/*` — a hook runs on the next `git commit` **on the host**, and the
 *    workspace is bind-mounted into the container (`bin/lib/container.sh#build_run_args`),
 *    so a write made inside the container lands in the host's `.git`.
 *  - `.git/config` — `core.hooksPath` points git at any directory of its choosing, so a
 *    config write is a hook write one indirection away.
 *  - `.env.moncho` — the runner *sources* it as shell (`bin/lib/env.sh#load_env_file`),
 *    so a line the model wrote executes on the host the next time the CLI starts.
 *
 * The threat this answers is **injection through the model's context**: a prompt-injected
 * model that writes one of these paths has achieved code execution on the host, outside
 * the container, with the user's own privileges. A sandbox that only asks "is this inside
 * the project?" answers *yes* to all three, so the question has to be asked again in the
 * one place every writer goes through.
 *
 * The fence is a **refusal**, not a normalisation: unlike the tracking pair
 * (`utils/tracking-fence.js`), there is no draft a host-executable file could legitimately
 * become. The model is told what to do instead — change the file's content through a
 * path the user owns, or ask the user to make the change.
 *
 * The name comparison is done on the **resolved project-relative path**, so the answer does
 * not depend on how the caller spelled it: `./.git/hooks/pre-commit`, `.git//hooks/../hooks/pre-commit`
 * and `.git/hooks/pre-commit` all name the same file. Matching is case-sensitive because
 * git and the shell are.
 */

/** The stable code a fenced path comes back with. */
export const HOST_EXEC_REFUSAL = 'HOST_EXECUTABLE_PATH';

/** The directory whose contents the host's git runs. */
export const GIT_DIR = '.git';

/** The env file the host runner sources as shell. */
export const ENV_FILE = '.env.moncho';

/** The git config file, which can redirect the hook directory. */
const GIT_CONFIG = 'config';

/** A git hook name: `pre-commit`, `post-checkout`, `pre-push`, … */
const HOOK_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * The path's segments, with `\` accepted as a separator and `.`/empty dropped.
 *
 * `..` is *not* resolved here: a segment that walks upwards is left in place so the
 * comparison fails closed. A path that has to be normalised before it can be judged is a
 * path the caller should not have written, and the file tools refuse it elsewhere.
 */
function segmentsOf(value) {
  return String(value ?? '').trim().replace(/\\/g, '/').split('/')
    .filter((part) => part !== '' && part !== '.');
}

/**
 * The kind of host-executable path `path` names, or `null` for an ordinary file.
 *
 * - `'git-hook'` — a hook inside `.git/hooks/`
 * - `'git-config'` — the repository's own `.git/config`
 * - `'env-file'` — the file the runner sources as shell
 *
 * @param {string} path a project-relative path, as the tool received it
 * @returns {'git-hook'|'git-config'|'env-file'|null}
 */
export function hostExecutableKind(path) {
  const parts = segmentsOf(path);
  if (parts.length === 0) return null;

  // The env file is named by its basename wherever it sits: the runner looks for
  // `$WORKSPACE/.env.moncho` (`bin/lib/env.sh#resolve_env_file`), and a copy anywhere in
  // the tree is the same shell text waiting to be sourced.
  if (parts[parts.length - 1] === ENV_FILE) return 'env-file';

  // A git directory is only special at the repository root: a project's own `.git` is the
  // one the host's git reads. A nested `sub/.git` is a submodule's, and its hooks run in
  // the submodule's own context — still the host's shell, so it is refused too.
  const gitAt = parts.indexOf(GIT_DIR);
  if (gitAt === -1) return null;

  const rest = parts.slice(gitAt + 1);
  if (rest.length === 0) return null;
  // `.git/hooks/<name>` — the hook itself. `hooks/` and anything deeper under it count,
  // because a directory's creation is how a hook arrives.
  if (rest[0] === 'hooks' && rest.length >= 2 && HOOK_NAME.test(rest[1])) return 'git-hook';
  // `.git/config` — `core.hooksPath` is a hook directory by another name.
  if (rest.length === 1 && rest[0] === GIT_CONFIG) return 'git-config';
  return null;
}

/** True when the path is one a host executes, wherever it sits in the tree. */
export function isHostExecutable(path) {
  return hostExecutableKind(path) !== null;
}

/**
 * The refusal for a write, edit or delete that names a host-executable path, or `null`.
 *
 * The message names the *kind* and the mechanism, because the model's next move depends on
 * it: a hook or the env file is not a project file it should try a different spelling of,
 * it is a file the user owns and the host runs.
 *
 * **The maintainer flow is exempt.** A maintainer develops this repository through
 * `./start.sh`, reads every diff and owns the checkout, so the fence is the thing in their
 * way: `MONCHO_MAINTAINER=1` turns it off (`config/constants.js#HOST_FENCE`) and they write
 * their own hooks. The switch is a parameter rather than a module-level early return so a
 * test can prove both sides without reloading the module.
 *
 * @param {string} path the path argument of the call
 * @param {boolean} [enabled] whether the fence applies; defaults to the configured switch
 * @returns {{status: string, code: string, message: string, guidance: string, path: string}|null}
 */
export function hostExecutableRefusal(path, enabled = HOST_FENCE) {
  if (!enabled) return null;
  const kind = hostExecutableKind(path);
  if (!kind) return null;

  const named = {
    'git-hook': {
      what: 'a git hook',
      why: 'git runs it on the host at the next commit, so writing it would run the model\'s '
        + 'code as you',
      instead: 'If the user wants a hook, tell them what it should do and let them create it. '
        + 'The project files themselves are editable as usual.',
    },
    'git-config': {
      what: 'the repository\'s git config',
      why: 'it can point git at a hook directory of its choosing, so it is a hook by another name',
      instead: 'Leave the repository configuration to the user. Change the project files instead.',
    },
    'env-file': {
      what: 'the env file the runner sources as shell',
      why: 'the host executes its contents as your own shell when the CLI starts',
      instead: 'Tell the user which variable to set and let them edit the file. '
        + 'Nothing about the project needs to be written here.',
    },
  }[kind];

  return {
    status: 'error',
    code: HOST_EXEC_REFUSAL,
    message: `${path} is ${named.what}: ${named.why}.`,
    guidance: named.instead,
    path,
  };
}
