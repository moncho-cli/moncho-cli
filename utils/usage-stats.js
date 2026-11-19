import { estimateTextTokens, formatTokenCount } from './tokens.js';
import { formatDuration } from './working-time.js';

/**
 * Token usage accounting, per model (task-backlog: "within each session, we
 * should be saving token usage by model so we can have stats on the performance
 * of the models").
 *
 * The status bar answers "how full is the window *right now*". This module
 * answers a different question — "how much did each model cost me in this
 * session?" — so the unit of account is the **call**, not the chunk:
 *
 *   - one entry per model, holding the request count and the prompt /
 *     completion / total tokens that model consumed;
 *   - an entry says how many of its calls were reported by the provider
 *     (`exactRequests`) and how many had to be estimated (`estimatedRequests`),
 *     because mixing the two silently would make a comparison a lie;
 *   - the same entry carries the **working** time attributed to that model
 *     (`thinkingMs`, `toolMs`): how long it spent thinking and how long the tool
 *     calls it asked for spent resolving (task-backlog: "add working time counter
 *     to sessions … save this also in the usage stats"). Time is written by
 *     `applyTime()` / `createUsageMeter().recordTime()`, never by `applyCall()`,
 *     because a call is counted when its answer lands while a span is timed around
 *     it (`utils/working-time.js`);
 *   - everything is a plain JSON object, so a session file can store it and the
 *     store can validate it when it is read back.
 *
 * Pure: no provider, no clock, no terminal.
 */

/** Key used when the caller never named a model. */
export const UNKNOWN_MODEL = 'unknown model';

/** The counters a model entry holds. */
const COUNTERS = [
  'requests',
  'exactRequests',
  'estimatedRequests',
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'thinkingMs',
  'toolMs',
];

/** A non-negative integer counter, or 0. */
function toCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
}

/** The zero entry for one model. */
export function emptyModelUsage() {
  return {
    requests: 0,
    exactRequests: 0,
    estimatedRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    thinkingMs: 0,
    toolMs: 0,
  };
}

/** Coerce one stored entry into the counters, dropping anything unknown. */
function sanitizeEntry(raw) {
  const entry = emptyModelUsage();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return entry;
  for (const key of COUNTERS) entry[key] = toCount(raw[key]);
  return entry;
}

/**
 * The table in its canonical shape: `{ [model]: entry }`.
 *
 * Defensive on purpose — this is what a session file says, so a hand-edited or
 * older file must not be able to break a listing. Unknown keys are dropped,
 * counters are clamped to non-negative integers, and entries under an empty name
 * are discarded instead of being merged into someone else's model.
 */
export function normalizeModelUsage(table = {}) {
  const out = {};
  if (!table || typeof table !== 'object' || Array.isArray(table)) return out;
  for (const [name, entry] of Object.entries(table)) {
    const key = String(name ?? '').trim();
    if (!key) continue;
    out[key] = sanitizeEntry(entry);
  }
  return out;
}

/**
 * Add one call to a model entry, returning a new entry.
 *
 * `usage` is what the provider reported (exact); `estimated` is what the caller
 * worked out itself. A call with no `usage` is counted as estimated — never as
 * exact — so the two can always be told apart afterwards.
 */
export function applyCall(entry, { usage = null, estimated = null } = {}) {
  const next = sanitizeEntry(entry);
  const source = usage || estimated || {};
  const promptTokens = toCount(source.promptTokens);
  const completionTokens = toCount(source.completionTokens);
  const totalTokens = toCount(source.totalTokens) || promptTokens + completionTokens;

  next.requests += 1;
  if (usage) next.exactRequests += 1;
  else next.estimatedRequests += 1;
  next.promptTokens += promptTokens;
  next.completionTokens += completionTokens;
  next.totalTokens += totalTokens;
  return next;
}

/**
 * Add one timed span to a model entry, returning a new entry.
 *
 * Kept apart from `applyCall()` on purpose: tokens are counted per *call* (the
 * answer that landed), while time is counted per *span* (how long the model was
 * thinking, how long a tool batch took). A call retried twice is still one request
 * but three thinking spans, and both facts have to survive.
 */
export function applyTime(entry, { thinkingMs = 0, toolMs = 0 } = {}) {
  const next = sanitizeEntry(entry);
  next.thinkingMs += toCount(thinkingMs);
  next.toolMs += toCount(toolMs);
  return next;
}

/** The sums across every model, plus how many models there are. */
export function totalUsage(table = {}) {
  const normalized = normalizeModelUsage(table);
  const totals = emptyModelUsage();
  let models = 0;
  for (const entry of Object.values(normalized)) {
    models += 1;
    for (const key of COUNTERS) totals[key] += entry[key];
  }
  return { models, ...totals };
}

/** One display line describing a model (or the totals) entry. */
export function formatUsageRow(name, entry) {
  const row = sanitizeEntry(entry);
  const split = row.estimatedRequests === 0
    ? 'all exact'
    : `${row.exactRequests} exact, ${row.estimatedRequests} estimated`;
  const line = `${name} — ${row.requests} request(s) (${split}) · prompt ${formatTokenCount(row.promptTokens)}`
    + ` · completion ${formatTokenCount(row.completionTokens)} · total ${formatTokenCount(row.totalTokens)}`;
  // The working time is appended only when there is some: a table written before
  // the counter existed — or one a unit test only gave tokens to — keeps exactly
  // the row it always had.
  const worked = row.thinkingMs + row.toolMs;
  if (worked <= 0) return line;
  return `${line} · working ${formatDuration(worked)}`
    + ` (thinking ${formatDuration(row.thinkingMs)}, tools ${formatDuration(row.toolMs)})`;
}

/**
 * The `/usage` report: one line per model, alphabetical so two runs can be
 * compared line by line, then a total when more than one model was used.
 * An empty table says so instead of printing a table of zeros.
 */
export function formatUsageRows(table = {}) {
  const normalized = normalizeModelUsage(table);
  const names = Object.keys(normalized).sort((a, b) => a.localeCompare(b));
  if (names.length === 0) return ['No provider call has been recorded in this session yet.'];

  const lines = ['Token usage per model (this session):'];
  for (const name of names) lines.push(`  ${formatUsageRow(name, normalized[name])}`);

  const totals = totalUsage(normalized);
  if (totals.models > 1) lines.push(`  ${formatUsageRow('total', totals)}`);
  return lines;
}

/**
 * The live meter the conversation loop records into.
 *
 * `record()` is the only mutator of the *token* counters: it keys the call by the
 * model that answered it and keeps the table immutable from the outside, so a
 * reader can hold a snapshot without seeing it change under its hands.
 * `recordTime()` is the second mutator, for the working-time counters, and
 * `replace()` is what resuming a session uses: the session file is the accounting
 * record, so its table becomes the live one instead of being added on top of it (a
 * resume can happen twice).
 */
export function createUsageMeter({ models = {} } = {}) {
  let table = normalizeModelUsage(models);

  const meter = {
    /** Model names seen so far, alphabetical. */
    get models() {
      return Object.keys(table).sort((a, b) => a.localeCompare(b));
    },
    /** Count one call against `model`; returns the updated entry. */
    record(model, call = {}) {
      const key = String(model ?? '').trim() || UNKNOWN_MODEL;
      const entry = applyCall(table[key], call);
      table = { ...table, [key]: entry };
      return entry;
    },
    /**
     * Count one timed span against `model`; returns the updated entry.
     *
     * The model is the one that was thinking (a `thinking` span) or the one whose
     * tool calls were running (a `tool` span), so the table answers "which model
     * cost me the wall clock" and not only "which model cost me the tokens".
     */
    recordTime(model, span = {}) {
      const key = String(model ?? '').trim() || UNKNOWN_MODEL;
      const entry = applyTime(table[key], span);
      table = { ...table, [key]: entry };
      return entry;
    },
    /** A snapshot of the table (a copy: the meter keeps mutating its own). */
    table() {
      return normalizeModelUsage(table);
    },
    /** The sums across every model. */
    totals() {
      return totalUsage(table);
    },
    /** Start from a stored table (a resumed session). */
    replace(next = {}) {
      table = normalizeModelUsage(next);
      return meter.table();
    },
    /** Forget everything (a new conversation). */
    reset() {
      table = {};
      return meter.table();
    },
  };

  return meter;
}

/**
 * The fallback for a provider that reports no counters: estimate the call from
 * the prompt it was sent and the text it answered with, using the same
 * characters-per-token rule as the context window (`utils/tokens.js`), so the
 * table stays comparable with the meter.
 *
 * Callers pass this as `estimated`; `applyCall()` then counts the request as an
 * estimate, never as an exact reading.
 */
export function estimateCallUsage({ promptTokens = 0, completionText = '' } = {}) {
  const prompt = toCount(promptTokens);
  const completion = estimateTextTokens(completionText);
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
  };
}

/**
 * Count one finished provider call against `model`.
 *
 * `response` is the normalised provider answer: it carries `usage` when the
 * provider reported counters (`api/ollama.js#normalizeUsage`), and `promptTokens`
 * is what the caller measured *before* sending, used only for the fallback. A
 * provider that reports nothing therefore lands in the table as an estimate
 * instead of being dropped.
 */
export function recordProviderCall(meter, model, { response = null, promptTokens = 0 } = {}) {
  if (!meter || typeof meter.record !== 'function') return null;
  return meter.record(model, {
    usage: response?.usage || null,
    estimated: estimateCallUsage({
      promptTokens,
      completionText: response?.message?.content ?? '',
    }),
  });
}
