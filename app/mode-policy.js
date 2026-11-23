import { MODES, normalizeMode } from './session-mode.js';
import { TOOL_GUARD_REFUSAL } from './tool-guard.js';

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
 * | `design` | the read-only set, plus `update_task` | its own `task.md` / `implementation_plan.md`, through `write_plan_md` / `edit_plan_md` |
 * | `work` | everything | everything |
 *
 * **A `design` session writes through tools that take no path.** That is the load-bearing
 * decision here. It used to be offered the generic `write_file` / `edit_file` and this
 * module policed their `path` argument against the session folder — a rule the model was
 * asked to respect and the gate had to enforce. `write_plan_md` / `edit_plan_md`
 * (`utils/tracking-draft.js`) name only *which* of the two documents they mean, and the
 * location comes from the store that owns it, so the scope is a property of the tool
 * rather than a check it performs. A tool that cannot name a file cannot name the wrong
 * one, which is why there is no path rule left to state: the two families below are
 * simply **not advertised** in `design`, and the gate refuses them if one is still named.
 *
 * A **shell is not a scoped writer**: `run_bash` / `run_npm` can write a file, rewrite
 * one or install a package, so they can never be restricted to two paths and are
 * therefore refused in both `chat` and `design`. Treating them as read-only would make
 * every other rule here decorative.
 *
 * A **delete is not a scoped write either**: a `design` session may author its own
 * checklist, but nothing it may write is anything it may destroy, so `delete_file` is its
 * own family (`DESTRUCTIVE_TOOLS`) and is refused in `chat` and `design` without a path
 * check.
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
 * `read_capture` belongs here too: a capture lives in memory
 * (`utils/capture-store.js`) and the tool names a handle, never a file, so it can
 * change nothing on disk.
 *
 * `web_fetch` belongs here as well, and it is the one member that leaves the project: it
 * is a **GET** over http(s) and nothing else (`utils/web-fetch.js`). A fetch reads a
 * remote resource exactly as `read_file` reads a local one — it cannot post, upload,
 * delete or write — so it is a reader and the read-only set is where it belongs.
 */
export const READ_ONLY_TOOLS = Object.freeze(['read_file', 'hint_file', 'blob', 'grep', 'read_capture', 'read_chunkpaction', 'web_fetch', 'compact_context']);

/**
 * The one tool that authors the tracking files. It is a writer, but a *scoped* one:
 * `tools/update_task.js` only ever touches `task.md` and `implementation_plan.md`, so
 * it belongs to `design` — the mode whose whole job is turning a discussion into a
 * backlog — without needing a path to check.
 */
export const TRACKING_TOOLS = Object.freeze(['update_task']);

/** The two files a `design` session may write, as the documents are named. */
export const DESIGN_WRITABLE_FILES = Object.freeze(['task.md', 'implementation_plan.md']);

/**
 * The writers a `design` session authors its two documents with.
 *
 * They are the mode's own tools, not the generic pair: neither takes a `path`, so the
 * scope is the tool's rather than a rule this module has to enforce. `write_plan_md`
 * authors a document from a draft (re-rendered into the canonical shape) and
 * `edit_plan_md` changes one by literal search/replace — the same two operations
 * `write_file` / `edit_file` perform everywhere else, minus the ability to name a target.
 */
export const DESIGN_WRITER_TOOLS = Object.freeze(['write_plan_md', 'edit_plan_md']);

/**
 * The generic writers: they name the file they touch, and they touch any file.
 *
 * They are `work`-only. A `design` session has `DESIGN_WRITER_TOOLS` for the two
 * documents it owns, so handing it these as well would only re-open the path question
 * the dedicated pair exists to close.
 */
export const SCOPED_WRITER_TOOLS = Object.freeze(['write_file', 'edit_file']);

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
export const WRITER_TOOLS = Object.freeze([
  ...SCOPED_WRITER_TOOLS, ...DESIGN_WRITER_TOOLS, ...SHELL_TOOLS, ...DESTRUCTIVE_TOOLS,
]);

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

/** How a refusal names the target of a call that carries a path, for the model's benefit. */
function targetOf(target) {
  return target === undefined ? 'an unnamed target' : `"${target}"`;
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

  // Design: the tracking loop and the mode's own two path-free writers, nothing else.
  if (TRACKING_TOOLS.includes(name)) return null;
  if (DESIGN_WRITER_TOOLS.includes(name)) return null;
  if (DESTRUCTIVE_TOOLS.includes(name)) {
    return refuse(
      `the session is in Design, which authors ${DESIGN_WRITABLE_FILES.join(' and ')} `
      + `and removes nothing, so ${name} on ${targetOf(target)} may not run`,
    );
  }
  if (SHELL_TOOLS.includes(name)) {
    return refuse(
      `the session is in Design, where a shell cannot be scoped to `
      + `${DESIGN_WRITABLE_FILES.join(' and ')}, so ${name} may not run`,
    );
  }
  return refuse(
    `the session is in Design, which writes only its own ${DESIGN_WRITABLE_FILES.join(' and ')} `
    + `and only through ${DESIGN_WRITER_TOOLS.join(' / ')}, so ${name} on ${targetOf(target)} may not run`,
  );
}

/**
 * The tool list a mode offers the provider: the same tool objects, filtered, so the
 * provider sees the real schemas and nothing else changes.
 *
 * `work` gets the whole list (a copy, never the caller's array), `chat` gets the
 * read-only set, and `design` gets the read-only set plus the tracking tool and the
 * mode's own path-free writers. A shell and the generic writers are advertised in
 * neither, so they are not even offered where they would be refused — which is the
 * whole point of the narrowed list: a tool the mode may not use costs tokens to send.
 *
 * An unknown mode is `chat` (the safe fallback, `app/session-mode.js#normalizeMode`).
 */
export function toolsForMode(mode, tools = []) {
  const list = Array.isArray(tools) ? tools : [];
  const current = normalizeMode(mode);
  if (current === MODES.WORK) return [...list];

  const allowed = current === MODES.DESIGN
    ? [...READ_ONLY_TOOLS, ...TRACKING_TOOLS, ...DESIGN_WRITER_TOOLS]
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
