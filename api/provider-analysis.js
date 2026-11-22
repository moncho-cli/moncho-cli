/**
 * The shape of a provider request, and why a provider refused it.
 *
 * A non-200 answer from a chat provider is nearly always about the **shape** of the
 * request, not about its size: the history the harness sent carries something the
 * provider's schema refuses, and the provider's own body says why. The harness used to
 * throw the status away (`HTTP error! status: 400`), so an operator was left with a
 * number and nothing to act on.
 *
 * This module is the **pure half** of that diagnosis: given a history and a body, it
 * answers what the request looked like and what the provider said about it. It touches
 * no network and no filesystem, so every rule below is provable on its own.
 *
 * The tool-call pairing is the finding this exists for. A provider refuses a history
 * whose `tool` messages do not answer the calls above them ("messages with role 'tool'
 * must be a response to a preceding message with 'tool_calls'"), and the harness can
 * produce exactly that: a compaction splits the window by token mass, not by call
 * boundaries, so the results of a batch can be summarised away while the batch's own
 * `tool_calls` message stays — or the other way round. The session then answers 400
 * forever, while a *new* session (a short, well-formed history) works. That is the
 * difference between "the provider is broken" and "this session's history is broken",
 * and it is visible only if the failing request is examined.
 *
 * One rule keeps this honest: **the log is not a second transcript**
 * (`docs/runtime/logging`). A request is described by its *shape* — roles, counts,
 * sizes, call ids — never by the words of the conversation. Only the provider's own
 * error body is quoted, because that is the diagnosis and not the conversation.
 */

/** How much of an error body is kept for the log. */
export const MAX_ERROR_BODY_CHARS = 4000;

/** How long a non-JSON body may be before it is no longer read as a reason. */
export const MAX_REASON_CHARS = 240;

/** The roles a request history is counted by, in the order they are reported. */
const ROLE_COUNTS = ['system', 'user', 'assistant', 'tool'];

/**
 * The provider's own reason, pulled out of an error body.
 *
 * The shapes seen in the wild:
 *  - OpenAI-compatible: `{ "error": { "message": "...", "code": ... } }`, and sometimes
 *    `{ "error": "a plain string" }`;
 *  - OpenRouter: the same, with the provider's own reason under `error.metadata.raw`;
 *  - Ollama: `{ "error": "model requires more system memory" }` — a plain string;
 *  - a bare text body: used as-is when it is short enough to read.
 *
 * @param {string} body the raw body text
 * @returns {{reason: string|null, code: string|null, body: string}}
 */
export function extractProviderReason(body) {
  const text = String(body ?? '');
  const empty = { reason: null, code: null, body: text };

  if (!text.trim()) return empty;

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: a short text body is the reason itself.
    const trimmed = text.trim();
    return trimmed.length <= MAX_REASON_CHARS
      ? { reason: trimmed, code: null, body: text }
      : empty;
  }

  const error = parsed?.error;
  if (typeof error === 'string') {
    return { reason: error, code: null, body: text };
  }
  if (error && typeof error === 'object') {
    const reason = error.message ?? error.detail ?? error.reason ?? error.type
      ?? error.metadata?.raw;
    const code = error.code ?? error.type ?? null;
    if (reason) return { reason: String(reason), code: code == null ? null : String(code), body: text };
  }
  if (typeof parsed?.message === 'string') {
    return { reason: parsed.message, code: parsed.code == null ? null : String(parsed.code), body: text };
  }
  if (typeof parsed?.detail === 'string') {
    return { reason: parsed.detail, code: null, body: text };
  }
  return empty;
}

/**
 * The tool-call pairing of one message history.
 *
 * A provider that speaks the OpenAI chat schema expects every assistant message with
 * `tool_calls` to be answered by one `tool` message per call id, and every `tool`
 * message to answer a call that is still in the history. A history that breaks either
 * rule is refused with a 400 — and it keeps being refused, because the history is
 * carried from call to call, while a *new* session starts from a clean one.
 *
 * The analysis is deliberately reported as **facts about the ids**, never as a verdict:
 * the operator reads the ids and sees which call lost its result.
 *
 * @param {object[]} messages the history the request carried
 * @returns {{calls: number, results: number, unansweredCalls: string[], orphanResults: string[], balanced: boolean}}
 */
export function analyzeToolPairing(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const called = [];
  const answered = [];

  for (const message of list) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call?.id) called.push(String(call.id));
      }
    }
    if (message.role === 'tool' && message.tool_call_id) {
      answered.push(String(message.tool_call_id));
    }
  }

  const calledSet = new Set(called);
  const answeredSet = new Set(answered);
  const unansweredCalls = called.filter((id) => !answeredSet.has(id));
  const orphanResults = answered.filter((id) => !calledSet.has(id));

  return {
    calls: called.length,
    results: answered.length,
    unansweredCalls,
    orphanResults,
    balanced: unansweredCalls.length === 0 && orphanResults.length === 0,
  };
}

/**
 * One message, described by its shape: its role, the size of its content and the call
 * ids it carries. The **words** are never copied — the log is not a second transcript
 * (`docs/runtime/logging`), and a description is what a diagnosis needs anyway.
 */
function describeMessage(message, index) {
  if (!message || typeof message !== 'object') return { index, role: 'unknown' };
  const described = { index, role: message.role || 'unknown' };
  const content = typeof message.content === 'string' ? message.content : '';
  if (content) described.contentChars = content.length;
  if (message.tool_call_id) described.tool_call_id = String(message.tool_call_id);
  if (Array.isArray(message.tool_calls)) {
    described.tool_calls = message.tool_calls.map((call) => String(call?.id ?? ''));
  }
  return described;
}

/**
 * The shape of the request that failed: enough to see *what* was sent, never the
 * conversation itself.
 *
 * @param {object[]} messages the history the request carried
 * @param {object[]} tools the advertised tool schemas
 * @returns {object} the shape
 */
export function describeRequestShape(messages = [], tools = []) {
  const list = Array.isArray(messages) ? messages : [];
  const roles = {};
  for (const role of ROLE_COUNTS) roles[role] = 0;
  for (const message of list) {
    const role = message?.role;
    if (role && role in roles) roles[role] += 1;
  }

  const contentBytes = list.reduce((sum, message) => {
    const content = typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '');
    return sum + Buffer.byteLength(content, 'utf-8');
  }, 0);

  return {
    messages: list.length,
    roles,
    contentBytes,
    tools: Array.isArray(tools) ? tools.length : 0,
    lastMessages: list.slice(-8).map(describeMessage),
  };
}

/**
 * The whole record of one failed provider call: what came back, what was sent, and
 * whether the history the request carried is well-formed.
 *
 * @param {object} options
 * @param {object} options.response the fetch response that failed
 * @param {string} [options.body] the error body, if it was already read
 * @param {object[]} [options.messages] the history the request carried
 * @param {object[]} [options.tools] the advertised tool schemas
 * @param {boolean} [options.stream] whether the request was a streaming one
 * @param {string} [options.url] the endpoint the request went to
 * @param {string} [options.model] the model the request asked for
 * @returns {object} the record
 */
export function buildProviderDiagnostic({
  response = null,
  body = '',
  messages = [],
  tools = [],
  stream = false,
  url = '',
  model = '',
} = {}) {
  const { reason, code } = extractProviderReason(body);
  const pairing = analyzeToolPairing(messages);
  const shape = describeRequestShape(messages, tools);

  return {
    status: response?.status ?? null,
    statusText: response?.statusText || '',
    reason,
    code,
    body,
    url,
    model,
    stream,
    request: shape,
    pairing,
  };
}

/**
 * The one-line summary of a failed call, for the message of the log line.
 *
 * It leads with the provider's own reason when there is one, because that is what
 * names the cause; the status is always there, and the pairing is mentioned when the
 * history is not well-formed, because that is the finding worth acting on.
 *
 * @param {object} diagnostic the record from `buildProviderDiagnostic`
 * @returns {string} the summary
 */
export function formatProviderDiagnostic(diagnostic = {}) {
  const status = diagnostic.status ?? 'unknown';
  const reason = diagnostic.reason ? `: ${diagnostic.reason}` : '';
  const pairing = diagnostic.pairing;
  const pairingNote = pairing && !pairing.balanced
    ? ` (tool calls unanswered: ${pairing.unansweredCalls.length}, orphan results: ${pairing.orphanResults.length})`
    : '';
  return `provider answered ${status}${reason}${pairingNote}`;
}
