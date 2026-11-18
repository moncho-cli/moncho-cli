/**
 * Dependency-free token accounting for the context window (task.md items 3 & 8).
 *
 * Providers do not return a consistent token count for a *pending* request, so
 * the harness estimates. The estimate is deliberately conservative and always
 * rounded up, which keeps the compaction trigger (task.md item 8) on the safe
 * side of a provider's real limit.
 */

/** Rough characters-per-token ratio for mixed English/code text. */
export const CHARS_PER_TOKEN = 4;

/** Fixed overhead the chat template adds per message (role markers, separators). */
export const MESSAGE_OVERHEAD_TOKENS = 4;

/** Overhead of the tool/function schema block sent with every request. */
export const TOOL_SCHEMA_OVERHEAD_TOKENS = 24;

export function estimateTextTokens(text) {
  if (text === undefined || text === null) return 0;
  const value = typeof text === 'string' ? text : JSON.stringify(text);
  if (!value) return 0;
  return Math.ceil(value.length / CHARS_PER_TOKEN);
}

/**
 * Estimate the tokens a single message occupies. Handles plain strings (used by
 * the chunk-based context window) as well as OpenAI/Ollama chat messages with
 * content, tool calls and thinking blocks.
 */
export function estimateMessageTokens(message) {
  if (message === undefined || message === null) return 0;
  if (typeof message === 'string') return estimateTextTokens(message);

  let tokens = MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.role);
  tokens += estimateTextTokens(message.content);
  tokens += estimateTextTokens(message.thinking);

  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      tokens += estimateTextTokens(call?.id);
      tokens += estimateTextTokens(call?.type);
      tokens += estimateTextTokens(call?.function?.name);
      tokens += estimateTextTokens(call?.function?.arguments);
    }
  }

  if (message.context_chunks) tokens += estimateMessagesTokens(message.context_chunks);
  return tokens;
}

export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

/** Estimated cost of sending `messages` together with the tool schemas. */
export function estimateRequestTokens(messages, tools = []) {
  const toolTokens = Array.isArray(tools) && tools.length > 0
    ? estimateTextTokens(tools) + TOOL_SCHEMA_OVERHEAD_TOKENS
    : 0;
  return estimateMessagesTokens(messages) + toolTokens;
}

/** Human-readable token count, e.g. 12.3k. */
export function formatTokenCount(count) {
  const value = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
  if (value < 1000) return String(value);
  if (value < 1000000) return `${(value / 1000).toFixed(value < 10000 ? 2 : 1)}k`;
  return `${(value / 1000000).toFixed(1)}M`;
}

/** Interpret an environment-supplied budget, ignoring invalid values. */
export function parseTokenBudget(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Remaining tokens before compaction must run (never negative). */
export function remainingTokens(messages, maxTokens, tools = []) {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return Infinity;
  return Math.max(0, maxTokens - estimateRequestTokens(messages, tools));
}

/** True when the estimated usage has reached the configured limit. */
export function exceedsTokenBudget(messages, maxTokens, tools = []) {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return false;
  return estimateRequestTokens(messages, tools) > maxTokens;
}

/** Usage summary for the status bar, e.g. "1.2k / 8.0k tokens (15%)". */
export function formatUsage(messages, maxTokens, tools = []) {
  const used = estimateRequestTokens(messages, tools);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return `${formatTokenCount(used)} tokens (no limit)`;
  }
  const percent = Math.min(999, Math.round((used / maxTokens) * 100));
  return `${formatTokenCount(used)} / ${formatTokenCount(maxTokens)} tokens (${percent}%)`;
}
