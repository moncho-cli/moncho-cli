import { MODES, normalizeMode } from './session-mode.js';
import { TOOL_GUARD_REFUSAL } from './tool-guard.js';
import { SESSION_DIR } from '../utils/session-store.js';

/**
 * The mode as a *policy*: which tools a session may use, and which calls are refused.
 *
 * `docs/interface/modes` states the rule and this module is the one place that answers
 * it, in the two halves the contract names together:
 *
 * 1. `toolsForMode(mode, tools)` narrows the **tool list advertised to the provider**,
 *    so the model is not invited to call something it may not use;
 * 2. `gateForMode()` is the **pre-dispatch gate** `app/tool-guard.js` asks about every
 *    call, so a call named from an older prompt is refused structurally instead of
 *    touching anything.
 *
 * Neither half is "Chat cannot write" on its own — the list is an invitation and only
 * the gate is a guarantee — which is why both live here, next to each other, off one
 * table:
 *
 * | mode | may read | may write |
 * | ---- | -------- | --------- |
 * | `chat` | the read-only set | no tool: its own session record is the host's |
 * | `design` | the read-only set, plus `update_task` | `task.md` / `implementation_plan.md`, through `write_file` / `patch_file` |
 * | `work` | everything | everything |
 *
 * A **shell is not a scoped writer**: `run_bash` / `run_npm` can write a file, rewrite
 * one or install a package, so they can never be restricted to two paths and are
 * therefore refused in both `chat` and `design`. Treating them as read-only would make
 * every other rule here decorative.
 *
 * A **delete is not a scoped write either**: `write_file` and `patch_file` are scoped by
 * path because a `design` session authors exactly two documents, and a document can be
 * corrected by writing it again. Nothing a mode may write is anything it may destroy, so
 * `delete_file` is its own family (`DESTRUCTIVE_TOOLS`) and is refused in `chat` and
 * `design` without a path check — a `design` session has no writable file worth keeping
 * *and* no reason to remove one.
 *
 * Pure and terminal-free: the tool list is passed in and the answer is a value, so the
 * whole policy is unit tested without a provider or a screen.
 *
 * @see docs/interface/modes
 */

/**
 * Tools that only *look*: they cannot create, change or remove anything on disk.
 * `compact_context` belongs here because "read-only" is a claim about the **project
 * tree**: it replaces the live context window and may call the provider, so it changes
 * the conversation without ever naming a path.
 */
export const READ_ONLY_TOOLS = Object.freeze(['read_file', 'blob', 'grep', 'compact_context']);

/**
 * The one tool that authors the tracking files. It is a writer, but a *scoped* one:
 * `tools/update_task.js` only ever touches `task.md` and `implementation_plan.md`, so
 * it belongs to `design` — the mode whose whole job is turning a discussion into a
 * backlog — without needing a path to check.
 */
export const TRACKING_TOOLS = Object.freeze(['update_task']);

/** The two files a `design` session may write, as they appear in a tool argument. */
export const DESIGN_WRITABLE_FILES = Object.freeze(['task.md', 'implementation_plan.md']);

/**
 * A `design` session writes its tracking files **where they live**: the project-root
 * names, or one session folder under `agent/sessions/`
 * (`agent/sessions/<id>/task.md`, `utils/tracking-store.js`). The folder is fixed, so
 * "design writes two files" stays a claim about two files rather than about any file
 * that happens to carry one of the two names.
 */
const SESSION_TRACKING_PREFIX = `${SESSION_DIR.replace(/\/+$/, '')}/`;

/** Writers that name the file they touch, so the policy can scope them by path. */
export const SCOPED_WRITER_TOOLS = Object.freeze(['write_file', 'patch_file']);

/**
 * The one tool that *removes* a file. It is a writer, and the strictest kind: a write
 * can be corrected by writing again, while a delete cannot be undone by retrying the
 * call. So it is never scoped to two paths — a `design` session may author `task.md`,
 * but there is no file it is allowed to destroy (the two it may write are held by
 * `update_task`, `utils/tracking-fence.js`). It is therefore refused in `chat` and
 * `design` alike, and advertised in neither.
 */
export const DESTRUCTIVE_TOOLS = Object.freeze(['delete_file']);

/** Writers that cannot be scoped: a shell reaches every path there is. */
export const SHELL_TOOLS = Object.freeze(['run_bash', 'run_npm']);

/** Every tool that can mutate something, scoped or not. */
export const WRITER_TOOLS = Object.freeze([...SCOPED_WRITER_TOOLS, ...SHELL_TOOLS, ...DESTRUCTIVE_TOOLS]);

/**
 * Normalise a path argument so `task.md`, `./task.md`, `/task.md` and `foo/../task.md`
 * are all compared as the same file: a policy a `./` prefix could walk around would be
 * worse than no policy at all.
 */
export function normalizeTargetPath(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  const segments = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return ''; // walks out of the project: never writable
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/** True when `target` names one of the files a `design` session may write. */
export function isDesignWritable(target) {
  const path = normalizeTargetPath(target);
  if (path === '') return false;
  if (DESIGN_WRITABLE_FILES.includes(path)) return true;
  // One session folder holding one of the two files: `agent/sessions/<id>/task.md`.
  // The id is whatever the session named itself, but the folder and the file name are
  // both fixed and no deeper nesting is accepted.
  if (!path.startsWith(SESSION_TRACKING_PREFIX)) return false;
  const rest = path.slice(SESSION_TRACKING_PREFIX.length).split('/');
  return rest.length === 2 && rest[0] !== '' && DESIGN_WRITABLE_FILES.includes(rest[1]);
}

/** The name a call names, from either accepted call shape. */
function callName(call) {
  return String(call?.name ?? call?.function?.name ?? '');
}

/** The path a call names, from either accepted call shape. */
function callPath(call) {
  return call?.args?.path ?? call?.function?.arguments?.path;
}

/** The tool name a tool *definition* declares (the shape `utils/tool-loader.js` builds). */
function toolName(tool) {
  return String(tool?.function?.name ?? tool?.name ?? '');
}

/**
 * A mode's decision about one call as a plain value, or `null` when it is allowed.
 *
 * The refusal names the mode, the tool and the target, because the model reads it: an
 * unexplained refusal invites the very same call again.
 */
export function refusalForMode(mode, call, name = callName(call)) {
  const current = normalizeMode(mode);
  const target = callPath(call);
  const refuse = (reason) => ({ reason, code: TOOL_GUARD_REFUSAL, mode: current, tool: name });

  if (current === MODES.WORK) return null;
  if (READ_ONLY_TOOLS.includes(name)) return null;

  if (current === MODES.CHAT) {
    return refuse(
      `the session is in Chat, which is strictly read-only, so ${name} may not run`,
    );
  }

  // Design: the two tracking files, and nothing else.
  if (TRACKING_TOOLS.includes(name)) return null;
  if (SCOPED_WRITER_TOOLS.includes(name) && isDesignWritable(target)) return null;
  if (DESTRUCTIVE_TOOLS.includes(name)) {
    return refuse(
      `the session is in Design, which authors ${DESIGN_WRITABLE_FILES.join(' and ')} `
      + `and removes nothing, so ${name} on ${target === undefined ? 'an unnamed target' : `"${target}"`} may not run`,
    );
  }
  if (SHELL_TOOLS.includes(name)) {
    return refuse(
      `the session is in Design, where a shell cannot be scoped to `
      + `${DESIGN_WRITABLE_FILES.join(' and ')}, so ${name} may not run`,
    );
  }
  return refuse(
    `the session is in Design, whose only writable files are ${DESIGN_WRITABLE_FILES.join(' and ')}, `
    + `so ${name} on ${target === undefined ? 'an unnamed target' : `"${target}"`} may not run`,
  );
}

/**
 * The tool list a mode offers the provider: the same tool objects, filtered, so the
 * provider sees the real schemas and nothing else changes.
 *
 * `work` gets the whole list (a copy, never the caller's array), `chat` gets the
 * read-only set, and `design` gets the read-only set plus the tracking tool and the
 * scoped writers — the gate is what keeps those two on the tracking files. A shell is
 * advertised in neither, so it is not even offered where it would be refused.
 *
 * An unknown mode is `chat` (the safe fallback, `app/session-mode.js#normalizeMode`).
 */
export function toolsForMode(mode, tools = []) {
  const list = Array.isArray(tools) ? tools : [];
  const current = normalizeMode(mode);
  if (current === MODES.WORK) return [...list];

  const allowed = current === MODES.DESIGN
    ? [...READ_ONLY_TOOLS, ...TRACKING_TOOLS, ...SCOPED_WRITER_TOOLS]
    : [...READ_ONLY_TOOLS];
  return list.filter((tool) => allowed.includes(toolName(tool)));
}

/**
 * The gate `app/tool-batch.js` asks about every call, for one mode.
 *
 * It reads the state through `getMode` on **every** call instead of capturing one, so
 * a `Tab` mid-turn tightens the very next call rather than the next session: the mode
 * and the lock are live state, not a snapshot taken at startup.
 *
 * @param {{mode?: string, work?: boolean, getMode?: function}} [options] the mode
 *   itself, or a `getMode()` returning `{ mode, work }` (a `createSessionMode()`).
 */
export function gateForMode({ mode = null, work = false, getMode = null } = {}) {
  const live = typeof getMode === 'function' ? getMode : null;
  return (call) => {
    const state = live ? live() : { mode, work };
    // A locked session is a `work` session: the lock pins the mode, so the policy reads
    // the mode alone and the lock only ever widens what is allowed.
    return refusalForMode(state?.work ? MODES.WORK : state?.mode, call);
  };
}
