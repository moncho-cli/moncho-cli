import { getIntentFromRaw, parseToolArgs } from '../utils/tool-schema.js';

/**
 * The one place that decides how a tool call looks.
 *
 * The live conversation loop (`app/conversation-manager.js`), the host's result
 * echo (`main.js`) and the session replay (`app/session-replay.js`) all have to
 * render the same thing — a `-> Calling <name>(<args>)` line, its `intent:` line,
 * the `[<tool> Output]` header and the body of the result chunk. Keeping those
 * shapes here is what stops a resumed conversation from looking different from
 * the one that produced it.
 *
 * Pure: string in, string out, no terminal and no model.
 */

/**
 * Compact, readable summary of a call's arguments: a short string is shown as it
 * is, a long one becomes `string(N chars)`, numbers and booleans verbatim, and
 * anything structured collapses to `[object Object]`.
 */
export function formatArgs(args) {
  if (typeof args === 'string') {
    return args.length <= 20 ? args : `string(${args.length} chars)`;
  }

  if (typeof args === 'object' && args !== null) {
    const parts = [];
    for (const [key, value] of Object.entries(args)) {
      let displayValue;
      if (typeof value === 'string') {
        displayValue = value.length <= 150 ? value : `string(${value.length} chars)`;
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        displayValue = `${value}`;
      } else {
        displayValue = '[object Object]';
      }
      parts.push(`${key}: ${displayValue}`);
    }
    return parts.join(', ');
  }

  return `${args}`;
}

/** One call as `{ id, name, args, rawArgs, intent }`. */
export function normalizeToolCall(call, index = 0) {
  const rawArgs = call?.function?.arguments;
  let args = rawArgs;
  if (typeof rawArgs === 'string') {
    try { args = parseToolArgs(rawArgs); } catch { args = rawArgs; }
  }
  return {
    id: call?.id || `call_${index}`,
    name: call?.function?.name || 'unknown_tool',
    args,
    rawArgs,
    intent: getIntentFromRaw(rawArgs),
  };
}

/**
 * Normalise the `tool_calls` of one assistant chunk into the shape the renderers
 * and the replay need (see normalizeToolCall).
 *
 * The arguments arrive as a JSON string (OpenAI shape) or already parsed; a
 * broken string is kept as-is so the summary still says something instead of
 * throwing.
 */
export function normalizeToolCalls(chunk) {
  const calls = Array.isArray(chunk?.tool_calls) ? chunk.tool_calls : [];
  return calls.map((call, index) => normalizeToolCall(call, index));
}

/** The `-> Calling …` and `intent:` lines the loop prints for one call. */
export function formatCallLines({ name, args, intent } = {}) {
  return [
    `\n  -> Calling ${name}(${formatArgs(args)})`,
    `     intent: ${intent}`,
  ];
}

/** The header of a tool-result block (main.js builds exactly this). */
export function formatToolHeader(toolName, intent = '') {
  return `\n  [${toolName} Output]${intent ? ` (intent: ${intent})` : ''}`;
}

/**
 * The content stored in a `tool` chunk: the call's intent first, so the reason for
 * the call stays in the model's context, then the result (marked `[error]` when
 * the tool failed).
 */
export function formatToolResultChunk({ intent, result, isError = false } = {}) {
  const body = typeof result === 'string' ? result : JSON.stringify(result);
  return isError ? `intent: ${intent}\n[error] ${body}` : `intent: ${intent}\n${body}`;
}

/**
 * The inverse of `formatToolResultChunk`, for the replay: a stored tool chunk is
 * `intent: <intent>` on its first line followed by the result body.
 *
 * The body follows the raw bytes, so a chunk that does not have the expected
 * shape is rendered as a body with no intent rather than throwing.
 */
export function parseToolChunk(content) {
  const text = String(content ?? '');
  const newline = text.indexOf('\n');
  const first = newline === -1 ? text : text.slice(0, newline);
  const rest = newline === -1 ? '' : text.slice(newline + 1);

  const match = first.match(/^intent:\s*(.*)$/);
  const intent = match ? match[1] : '';
  const body = match ? rest : text;
  const isError = /^\[error\]/.test(body);
  return {
    intent,
    isError,
    body: isError ? body.replace(/^\[error\]\s?/, '') : body,
  };
}
