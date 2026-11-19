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

/** Token budget for the context window; exceeding it triggers a compaction. */
export const CONTEXT_MAX_LENGTH = toPositiveInt(process.env.CONTEXT_MAX_LENGTH, 128000);
/** The raw CONTEXT_MAX_LENGTH override, or null when the user did not set one. */
/** (task.md item 3: without an override the real total comes from the provider.) */
export const CONTEXT_MAX_LENGTH_OVERRIDE = toPositiveInt(process.env.CONTEXT_MAX_LENGTH, null);
/** Older share of the window that is replaced by a single summary chunk. */
export const COMPACTION_OLD_RATIO = 0.7;
/** Newer share of the window that is kept verbatim. */
export const COMPACTION_KEEP_RATIO = 0.3;
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
/** The guidance a refused call carries, so the model can correct itself. */
export const TOO_MANY_TOOL_CALLS_GUIDANCE =
  `Ask for at most ${MAX_PARALLEL_TOOL_CALLS} tools at a time and wait for their results before the next batch.`;
