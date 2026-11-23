export const ALLOWED_COMMANDS = [
  'ls',
  'mkdir',
  'pwd',
  'cat',
  'grep',
  'find',
  'echo',
  'date',
  'whoami',
  'node',
  'git',
  'wc'
];

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------
// Provider configuration. Values are injected by start.sh (via .env) and read here,
// with safe fallbacks so local/Ollama usage keeps working when no env is provided.
const RAW_BASE_URL =
  process.env.OPENAI_BASE_URL || "http://host.containers.internal:11434/api/chat";
export const BASE_URL = RAW_BASE_URL;
export const API_KEY = process.env.OPENAI_API_KEY || "";
export const MODEL = process.env.OPENAI_MODEL || "qwen3.6:35b-a3b-q4_K_M";

/**
 * The `User-Agent` a provider call carries, when the user configures one.
 *
 * It is **opt-in**: `MONCHO_USER_AGENT` is sent only when it is set, so an unconfigured
 * install presents no header of its own and the provider sees the request it would have
 * seen before this knob existed. A blank or whitespace-only value reads as **unset**,
 * because an empty header is not a request anyone means to send.
 */
function toUserAgent(value) {
  const raw = String(value ?? '').trim();
  return raw === '' ? null : raw;
}

/**
 * The `User-Agent` a provider call sends, or `null` when none is configured.
 * Configurable through `MONCHO_USER_AGENT`; see `api/ollama.js#buildHeaders`.
 */
export const USER_AGENT = toUserAgent(process.env.MONCHO_USER_AGENT);

/**
 * A sampling temperature as a number, or `null` when the value cannot be used.
 *
 * `null` is a real answer here, not a failure: the temperature is **absent** from
 * the request unless the user asks for it, so the provider's own default applies
 * exactly as it did before this knob existed. A value outside the conventional
 * 0–2 range, or one that does not parse, is treated as unset rather than sent —
 * a typo must not silently change how the model answers.
 */
function toTemperature(value) {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) return null;
  return parsed;
}

/**
 * The temperature a model call is sent with, or `null` for "do not send one".
 * Configurable through `MODEL_TEMPERATURE`; see `api/ollama.js#buildBody`.
 */
export const MODEL_TEMPERATURE = toTemperature(process.env.MODEL_TEMPERATURE);

/**
 * The default cap on tokens Ollama may generate in one response.
 *
 * A local thinking model otherwise generates into the thousands of tokens and the
 * request dies before it answers; a cap forces it to settle on a decision. The value
 * is a **default**, not a constant: `OLLAMA_MAX_TOKENS` overrides it.
 */
export const OLLAMA_MAX_TOKENS_DEFAULT = 512;

/**
 * A token cap, or `null` for "send no cap".
 *
 * Unset falls back to the default; `0`, `off`, `none` and `unlimited` turn the cap
 * **off** so the provider's own default applies; anything unparseable falls back to
 * the default rather than silently removing the cap.
 */
function toTokenCap(value, fallback) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "") return fallback;
  if (["0", "off", "none", "unlimited"].includes(raw)) return null;
  return toPositiveInt(raw, fallback);
}

/**
 * How many tokens a model call may generate, or `null` for "send no cap".
 * Configurable through `OLLAMA_MAX_TOKENS`; see `api/ollama.js#buildBody`.
 */
export const OLLAMA_MAX_TOKENS = toTokenCap(process.env.OLLAMA_MAX_TOKENS, OLLAMA_MAX_TOKENS_DEFAULT);

// Alias kept for the live smoke test (agent/utils/stream-smoke-test.js).
export const OLLAMA_URL = BASE_URL;

/**
 * Best-effort provider name for the status bar (task.md: "name of the model and
 * provider"). Derived from the configured base URL, so switching providers in
 * .env needs no code change.
 */
export function detectProvider(baseUrl = BASE_URL) {
  const url = String(baseUrl || "");
  if (/openrouter\.ai/i.test(url)) return "openrouter";
  if (/api\.openai\.com/i.test(url)) return "openai";
  if (/anthropic|claude/i.test(url)) return "anthropic";
  if (/generativelanguage|gemini/i.test(url)) return "gemini";
  if (/:11434\b|\/api\/chat/.test(url)) return "ollama";
  try {
    return new URL(url).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

export const PROVIDER = detectProvider(BASE_URL);

export function describeModel() {
  return {
    provider: PROVIDER,
    model: MODEL,
    baseUrl: BASE_URL,
    label: `${PROVIDER} · ${MODEL}`
  };
}

// ---------------------------------------------------------------------------
// Harness tool protocol (task.md item 6: every tool call carries an "intent")
// ---------------------------------------------------------------------------
export const INTENT_PARAM_NAME = "intent";
export const INTENT_PARAM_DESCRIPTION =
  "Short phrase describing why this tool is being called and what to do with the result.";
export const MISSING_INTENT_PLACEHOLDER = "(no intent provided)";

// ---------------------------------------------------------------------------
// Context window + compaction (task.md items 3 and 8)
// ---------------------------------------------------------------------------
function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * A share of the window, as a fraction strictly between 0 and 1.
 *
 * Accepts the three shapes a person actually writes in an env file: a fraction
 * (`0.7`), a percentage (`70`) and a percentage with the sign (`70%`). Anything
 * else — out of range, unparseable, empty — falls back, because a bad ratio must
 * never produce a split that evicts everything or keeps everything.
 */
function toRatio(value, fallback) {
  const raw = String(value ?? "").trim();
  if (raw === "") return fallback;
  const percent = raw.endsWith("%");
  const parsed = Number.parseFloat(percent ? raw.slice(0, -1) : raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  const ratio = percent || parsed >= 1 ? parsed / 100 : parsed;
  return ratio > 0 && ratio < 1 ? ratio : fallback;
}

/** Token budget for the context window; exceeding it triggers a compaction. */
export const CONTEXT_MAX_LENGTH = toPositiveInt(process.env.CONTEXT_MAX_LENGTH, 128000);
/** The raw CONTEXT_MAX_LENGTH override, or null when the user did not set one. */
/** (task.md item 3: without an override the real total comes from the provider.) */
export const CONTEXT_MAX_LENGTH_OVERRIDE = toPositiveInt(process.env.CONTEXT_MAX_LENGTH, null);
/**
 * The one knob of the compaction split: the older share of the window that is
 * replaced by a single summary chunk. Overridable through `COMPACTION_OLD_RATIO`
 * (`0.7`, `70` and `70%` all mean the same), because how aggressively to compact
 * is a deployment decision — a small window wants a bigger evicted share than a
 * large one. Anything out of range falls back to the default.
 */
export const COMPACTION_OLD_RATIO = toRatio(process.env.COMPACTION_OLD_RATIO, 0.7);
/**
 * The newer share of the window that is kept verbatim, *derived* from the one knob
 * above so the two always sum to 1 and no second env var can contradict the first.
 */
export const COMPACTION_KEEP_RATIO = 1 - COMPACTION_OLD_RATIO;
/** Marker prefixed to the summarised chunk so it is identifiable in the window. */
export const COMPACTION_SUMMARY_PREFIX = "[compacted summary of earlier context]";

// ---------------------------------------------------------------------------
// Model-call pulse (task-backlog: "keep in the context an incremental pulse on
// each model call, create a hard limit configurable defaulting to 30")
// ---------------------------------------------------------------------------
/** The hard limit of agent model calls between two resets, unless configured. */
export const PULSE_LIMIT_DEFAULT = 30;
/**
 * How many agent model calls one stretch of work may cost before the pulse line
 * tells the model the budget is spent. Configurable through `PULSE_LIMIT`;
 * anything that is not a positive integer falls back to the default.
 */
export const PULSE_LIMIT = toPositiveInt(process.env.PULSE_LIMIT, PULSE_LIMIT_DEFAULT);

// ---------------------------------------------------------------------------
// The host fence's maintainer switch
// ---------------------------------------------------------------------------
/**
 * Whether the host fence (`utils/host-fence.js`) refuses the paths the host executes.
 *
 * Two flows, two audiences. A **user** runs the agent against a project they own and does
 * not read its diffs, so the fence is on and a prompt-injected model cannot write a git
 * hook or the env file the host sources. A **maintainer** develops this repository through
 * `./start.sh`, reads every diff and owns the checkout, so the fence is the thing in their
 * way: they set `MONCHO_MAINTAINER=1` and write their own hooks.
 *
 * The switch is an environment variable rather than a checkout check on purpose. The app
 * runs *inside* the container against a bind mount, so "is this the agent's checkout" would
 * mean reimplementing `bin/lib/template.sh#is_agent_checkout` in JavaScript against a path
 * the container cannot see as the host does — and it would also fire for a user who happens
 * to name their own project `moncho-cli`. An explicit variable is honest about being an
 * override, and it cannot be guessed wrong.
 *
 * It is read **when the fence is asked**, not once at import, for one concrete reason: the
 * suite runs *inside* the maintainer's container, where the variable is set, and a switch
 * frozen at module load would leave the fence off before any test ran — the refusal cases
 * could not pass, and a check that silently stops checking depending on where it runs is
 * worse than the bug it guards. A production process never changes its environment mid-run,
 * so reading late costs nothing and changes nothing there.
 */
export function hostFenceEnabled() {
  return process.env.MONCHO_MAINTAINER !== '1';
}

// ---------------------------------------------------------------------------
// run_npm allow-list
// ---------------------------------------------------------------------------
export const NPM_ALLOWED_SUBCOMMANDS = [
  "install",
  "i",
  "uninstall",
  "remove",
  "ci",
  "ls",
  "list",
  "view",
  "outdated",
  "explain",
  "test",
  "run",
  "pkg",
  "dedupe"
];
/** Hard ceiling for a single npm invocation (ms). */
export const NPM_DEFAULT_TIMEOUT_MS = 300000;
export const NPM_MAX_TIMEOUT_MS = 900000;

// ---------------------------------------------------------------------------
// Operational log (task-backlog: "save logs in some internal local log file that
// gets auto rotated by this same deterministic code ... the usual 3 levels:
// error, warning, info and a level threshold via environment")
// ---------------------------------------------------------------------------
/**
 * Where the operational log lives. It defaults into the gitignored `agent/` tree,
 * next to the sessions, because an operational log describes the workspace it is
 * written in; the path is still resolved through the sandbox every file tool uses
 * (utils/logger.js#createLogger).
 */
export const LOG_FILE = process.env.LOG_FILE || "agent/logs/moncho.log";
/** The raw threshold; utils/logger.js#normalizeLogLevel maps `warning` → `warn`, `off` → silent. */
export const LOG_LEVEL = process.env.LOG_LEVEL || "info";
/** Bytes the live file may hold before the next line rotates it (512 KiB). */
export const LOG_MAX_BYTES_DEFAULT = 512 * 1024;
export const LOG_MAX_BYTES = toPositiveInt(process.env.LOG_MAX_BYTES, LOG_MAX_BYTES_DEFAULT);
/** Files kept in the rotation chain, the live one included. */
export const LOG_MAX_FILES_DEFAULT = 5;
export const LOG_MAX_FILES = toPositiveInt(process.env.LOG_MAX_FILES, LOG_MAX_FILES_DEFAULT);
// ---------------------------------------------------------------------------
// Streaming thinking capture (api/ollama.js)
// ---------------------------------------------------------------------------
/**
 * Where the streaming reasoning is captured instead of the transcript. It defaults
 * into the gitignored `agent/` tree, next to the sessions and the log, so a container
 * run keeps it in the state volume rather than at the root of the user's checkout.
 * The path is resolved through the sandbox (`utils/path-safety.js#resolveProjectPath`).
 */
export const THINKING_FILE = process.env.THINKING_FILE || "agent/thinking.md";

// ---------------------------------------------------------------------------
// Clipboard copies (app/clipboard-file.js, docs/interface/clipboard-selection)
// ---------------------------------------------------------------------------
/**
 * How the workspace keeps saved selections: `single` or `all`.
 *
 * `single` (the default) leaves exactly **one** file — each new copy replaces the
 * previous one, so the workspace never accumulates scratch text. `all` keeps every
 * copy under its own timestamped name, which is what a reader who wants a history
 * of selections asks for. `timestamped` and `keep` are accepted spellings of `all`,
 * and anything else falls back to `single`: the safe side of this knob is the one
 * that leaves fewer files, not more.
 */
export function normalizeClipboardKeep(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "all" || raw === "timestamped" || raw === "keep" ? "all" : "single";
}

/**
 * Whether a saved selection is kept alone or alongside a history of its own
 * (task-backlog: "an environment variable to select if the clipboard copy behavior
 * is to keep creating files, or if it should be just 1 file and it only has the last
 * copy"). Read here and passed to the writer so the rule lives in one place.
 */
export const CLIPBOARD_FILE_KEEP = normalizeClipboardKeep(process.env.CLIPBOARD_FILE_KEEP);

// ---------------------------------------------------------------------------
// Task tracking files (task.md protocol: mark done, reset the plan, next item)
// ---------------------------------------------------------------------------
export const TASK_FILE = process.env.TASK_FILE || "task.md";
export const PLAN_FILE = process.env.PLAN_FILE || "implementation_plan.md";

// ---------------------------------------------------------------------------
// Tool batches (docs/agent/tool-multicall)
// ---------------------------------------------------------------------------
/**
 * How many tool calls of one assistant message run simultaneously. A model that
 * asks for more is answered for the first N and refused for the rest, so a
 * runaway batch cannot fan out without bound.
 */
export const MAX_PARALLEL_TOOL_CALLS = 5;
/** Stable result code for a call a batch refused to run. */
export const TOO_MANY_TOOL_CALLS = "TOO_MANY_TOOL_CALLS";
/**
 * How many times one turn may be refused for asking for tools before it has addressed
 * the user (docs/agent/approach-gate). The rule is enforced, not merely instructed,
 * but a refusal that could repeat forever would let a stubborn model deadlock the
 * turn: after this many refusals the batch runs and the skip is announced.
 */
export const APPROACH_MAX_REFUSALS = toPositiveInt(process.env.APPROACH_MAX_REFUSALS, 2);

// ---------------------------------------------------------------------------
// File size budget (task-backlog: "while we chose to develop with a hard limit
// of 300 lines, this must be configurable, ......")
// ---------------------------------------------------------------------------
/**
 * The default file size budget, in lines.
 *
 * The project chose 300 lines when it was small; 600 fits it now. The number is a
 * **default**, not a constant: it is the fallback for a configuration that is absent
 * or unusable, and it is what the agent prompt says when nobody configured otherwise.
 */
export const FILE_LINE_LIMIT_DEFAULT = 600;
/**
 * How many lines a file may hold before it must be split along its responsibilities.
 *
 * Configurable through `FILE_LINE_LIMIT`, because a limit that fits one moment of a
 * project's life and not the next is a habit rather than a rule. The value is
 * normalised by `utils/file-size-budget.js#normalizeFileLineLimit`, so a broken
 * environment variable can never disable the rule or invert it.
 */
export const FILE_LINE_LIMIT = toPositiveInt(process.env.FILE_LINE_LIMIT, FILE_LINE_LIMIT_DEFAULT);
/** The guidance a refused call carries, so the model can correct itself. */
export const TOO_MANY_TOOL_CALLS_GUIDANCE =
  `Ask for at most ${MAX_PARALLEL_TOOL_CALLS} tools at a time and wait for their results before the next batch.`;

// ---------------------------------------------------------------------------
// Read tools (task-backlog: "the blob tool when the parameters are too lax gives
// gigantic responses, the tool should reject losely defined arguments, same with
// other tools, and read_file should also have some sort of by default truncation,
// suggesting the model to first run greps and only read files after discovering
// context")
// ---------------------------------------------------------------------------
/**
 * The page `read_file` returns when the model does not ask for one.
 *
 * A bare read used to return the whole file, so one call on a generated bundle or a
 * data file could spend the window by itself and force a compaction. The number is a
 * **default**, not a limit on what the tool can do: `READ_MAX_LINES` configures it,
 * and `off` / `0` / `none` / `unlimited` remove it so the old behaviour is one
 * variable away. 2000 lines sits well above any file this project's own budget
 * allows (600 lines, ceiling 900), so a legitimate read is never capped and only the
 * pathological one is.
 */
export const READ_MAX_LINES_DEFAULT = 2000;
/**
 * How many lines one `read_file` page may hold unless the model asks for fewer.
 * Configurable through `READ_MAX_LINES`; a page the cap stopped is marked
 * `truncated=true` and reports `lines=<returned>/<total>` so the model can page.
 */
export const READ_MAX_LINES = toTokenCap(process.env.READ_MAX_LINES, READ_MAX_LINES_DEFAULT);

/**
 * Hard ceilings on what one `blob` call may return, whatever the model asks for.
 *
 * The defaults (8 files, 40 KiB each, 120 KiB total) already bound a bare call; the
 * ceilings bound the *request*, so a raised `maxFiles` / `maxTotalBytes` cannot turn
 * a loose call into a gigantic response. They are deliberately generous — several
 * times the default — because they exist to stop a runaway, not to ration a
 * deliberate read.
 */
export const BLOB_MAX_FILES_CEILING = 40;
export const BLOB_MAX_BYTES_PER_FILE_CEILING = 256 * 1024;
export const BLOB_MAX_TOTAL_BYTES_CEILING = 512 * 1024;
