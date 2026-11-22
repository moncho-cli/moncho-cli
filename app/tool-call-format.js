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

/**
 * The marker a tool-result row ends with, so a glance tells a call that went as
 * expected from one that has to be retried: `✓` on success, `✗` on failure.
 *
 * Display only, like the intent beside it: the chunk the model reads and the session
 * file keep the raw result, and the `[error]` prefix in the chunk is what tells the
 * model a call failed.
 */
export const TOOL_OK_MARK = '✓';
export const TOOL_FAIL_MARK = '✗';

/**
 * Whether a tool result reports a failure.
 *
 * Three shapes reach here: a tool's own result (the convention across `tools/` is a
 * JSON string carrying `status: "error"` plus a stable `code`,
 * `docs/agent/tool-call-contract`), the `[error] …` string the batch stores when a
 * handler throws or a call is refused, and a plain object with the same `status`.
 * A result that is none of those is a success.
 */
export function toolResultFailed(result) {
  if (typeof result === 'string') {
    const text = result.trimStart();
    if (/^\[error\]/.test(text)) return true;
    // A handler answers its own failure as JSON, so the shape has to be read, not
    // guessed from the text: only a parsed object with `status: "error"` counts.
    if (!text.startsWith('{')) return false;
    try {
      const parsed = JSON.parse(text);
      return Boolean(parsed && typeof parsed === 'object' && parsed.status === 'error');
    } catch {
      return false;
    }
  }
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result.status === 'error';
  }
  return false;
}

/** The header of a tool-result block (main.js builds exactly this). */
export function formatToolHeader(toolName, intent = '', { failed = false } = {}) {
  const mark = failed ? TOOL_FAIL_MARK : TOOL_OK_MARK;
  return `\n  [${toolName} Output]${intent ? ` (intent: ${intent})` : ''} ${mark}`;
}

// ---------------------------------------------------------------------------
// The batch signature and the multicall envelope (docs/agent/tool-multicall)
// ---------------------------------------------------------------------------
// A batch is one assistant message asking for several tools at once. The
// provider pairs every result with the id of the call it answers, so the chunk
// stays one per call; the envelope is what the model reads to see the *shape* of
// the call that produced it — `<tool-multicall result calls=1>` holding one
// `<tool-call name="…">` element.
// ---------------------------------------------------------------------------

/** Type summary of one argument: `string(11)`, `number`, `boolean`, … */
export function formatArgType(value) {
  if (typeof value === 'string') return `string(${value.length})`;
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

/**
 * How a call was shaped: the tool name plus the type of every parameter it was
 * called with, e.g. `read_file(path=string(11), intent=string(12))`.
 *
 * Lengths, never contents: the envelope describes the call while the payload
 * travels in the result body, so a signature adds shape without repeating the
 * output. A call whose arguments could not be parsed reports its raw size.
 */
export function formatCallSignature({ name = 'unknown_tool', args } = {}) {
  if (typeof args === 'string') return `${name}(raw=string(${args.length}))`;
  if (args === null || typeof args !== 'object') return `${name}()`;
  const parts = Object.entries(args).map(([key, value]) => `${key}=${formatArgType(value)}`);
  return `${name}(${parts.join(', ')})`;
}

/** The closing line of every envelope; the parser keys on it. */
export const MULTICALL_FOOTER = '</tool-multicall result>';

/** The opening line, carrying how many `<tool-call>` elements it holds. */
export function formatMulticallHeader(calls = 1) {
  return `<tool-multicall result calls=${Math.max(1, Number(calls) || 1)}>`;
}

/**
 * Wrap one call's result in the envelope written into its `tool` chunk. `calls`
 * is the size of the batch the assistant asked for, so the model can tell a lone
 * call from one of five asked at the same time.
 */
export function formatMulticallEnvelope({ entries = [], calls = null } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const lines = [formatMulticallHeader(calls ?? list.length)];
  for (const entry of list) {
    lines.push(`<tool-call name="${entry?.signature ?? ''}">`, String(entry?.body ?? ''), '</tool-call>');
  }
  lines.push(MULTICALL_FOOTER);
  return lines.join('\n');
}

/**
 * The inverse of `formatMulticallEnvelope`: `{ calls, elements, entries }` where
 * `calls` is the batch size the header declares and `entries` holds one
 * `{ signature, body }` per `<tool-call>` element, or null when the text is not
 * an envelope at all.
 *
 * The header's element count is what makes the parse unambiguous. A single
 * element is read greedily to the *last* `</tool-call>`, so a body that itself
 * quotes the envelope (a session file fetched by `read_file`) round-trips
 * byte-for-byte; an envelope holding several is split on each closing line, so
 * such a body must not carry one on a line of its own.
 */
export function parseMulticallEnvelope(text) {
  const source = String(text ?? '');
  const newline = source.indexOf('\n');
  const header = newline === -1 ? source : source.slice(0, newline);
  const head = header.match(/^<tool-multicall result(?:\s+calls=(\d+))?>\s*$/);
  if (!head) return null;

  const rest = newline === -1 ? '' : source.slice(newline + 1);
  if (!rest.endsWith(MULTICALL_FOOTER)) return null;
  const inner = rest.slice(0, rest.length - MULTICALL_FOOTER.length).replace(/\n$/, '');

  const declared = head[1] ? Number(head[1]) : 1;
  const entries = [];
  const single = inner.match(/^<tool-call name="([^"]*)">\n([\s\S]*)\n<\/tool-call>$/);
  if (declared <= 1 && single) {
    entries.push({ signature: single[1], body: single[2] });
  } else {
    for (const element of inner.matchAll(/<tool-call name="([^"]*)">\n([\s\S]*?)\n<\/tool-call>/g)) {
      entries.push({ signature: element[1], body: element[2] });
    }
  }
  if (entries.length === 0) return null;
  return { calls: declared, elements: entries.length, entries };
}

/**
 * The content stored in a `tool` chunk: the call's intent first, so the reason for
 * the call stays in the model's context, then the result (marked `[error]` when
 * the tool failed).
 *
 * A call made inside a batch also carries its signature, and its result is
 * wrapped in the multicall envelope. Without a signature the chunk keeps its
 * historical shape, so every session written before the envelope still reads
 * back exactly (`parseToolChunk` below is the companion reader).
 */
export function formatToolResultChunk({ intent, signature = null, result, isError = false, calls = 1 } = {}) {
  const body = typeof result === 'string' ? result : JSON.stringify(result);
  const marked = isError ? `[error] ${body}` : body;
  const head = `intent: ${intent}`;
  if (!signature) return `${head}\n${marked}`;
  return `${head}\n${formatMulticallEnvelope({ entries: [{ signature, body: marked }], calls })}`;
}

/**
 * The inverse of `formatToolResultChunk`, for the replay: a stored tool chunk is
 * `intent: <intent>` on its first line followed by the result body.
 *
 * A batched body arrives inside the multicall envelope; it is unwrapped before
 * the error marker is looked for, so the replay shows the tool's own output and
 * a chunk written before the envelope reads exactly as it did.
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
  const raw = match ? rest : text;

  const envelope = parseMulticallEnvelope(raw);
  const body = envelope ? envelope.entries[0].body : raw;
  const isError = /^\[error\]/.test(body);
  return {
    intent,
    signature: envelope ? envelope.entries[0].signature : '',
    calls: envelope ? envelope.calls : 1,
    isError,
    body: isError ? body.replace(/^\[error\]\s?/, '') : body,
  };
}
