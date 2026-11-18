/**
 * Display formatting for machine-readable results (task.md item 5).
 *
 * Tools and commands answer in JSON, and JSON printed on one line is unreadable
 * in a terminal. Everything here is pure text work — no widget, no screen — so the
 * rules are unit tested without a terminal, and both front ends (the TUI block and
 * the line CLI) can call the same formatter.
 *
 * The formatting is *display only*: the model still receives the raw tool result,
 * and a session file keeps the exact bytes. Only what the user sees is re-indented.
 */

/** Result keys that carry presentation, not payload. */
const PRESENTATION_KEYS = new Set(['ok', 'code', 'message', 'lines']);

/** True when the text is a JSON object or array (scalars are left alone). */
export function looksLikeJson(text) {
  const source = String(text ?? '').trim();
  if (!source.startsWith('{') && !source.startsWith('[')) return false;
  try {
    JSON.parse(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pretty-print a JSON value or a JSON string.
 *
 * - an object/array is serialised with `indent` spaces per level;
 * - a string that parses as a JSON object/array is re-indented;
 * - anything else (prose, a JSON scalar, a broken payload) is returned unchanged,
 *   so a formatter bug can never swallow a result.
 */
export function prettyPrintJson(value, { indent = 2 } = {}) {
  const width = Number.isInteger(indent) && indent >= 0 ? indent : 2;

  if (value && typeof value === 'object') {
    try {
      const text = JSON.stringify(value, null, width);
      return typeof text === 'string' ? text : String(value);
    } catch {
      return String(value);
    }
  }

  const source = String(value);
  if (!looksLikeJson(source)) return source;
  try {
    return JSON.stringify(JSON.parse(source), null, width);
  } catch {
    return source;
  }
}

/** Expand one display line, pretty-printing it when it is JSON. */
function expandLine(line, indent) {
  const text = String(line ?? '');
  const pretty = prettyPrintJson(text, { indent });
  return pretty === text ? [text] : pretty.split('\n');
}

/** The payload of a command result: every key that is not presentation. */
export function payloadOf(result) {
  if (!result || typeof result !== 'object') return null;
  const payload = {};
  for (const [key, value] of Object.entries(result)) {
    if (!PRESENTATION_KEYS.has(key)) payload[key] = value;
  }
  return Object.keys(payload).length > 0 ? payload : null;
}

/**
 * The display lines of a command result.
 *
 * `lines` and `message` are printed first (each JSON line expanded), and a result
 * that carries *only* payload — no prose at all — is printed as pretty JSON. A
 * result with a message keeps its payload out of the way: the summary says what
 * happened, and the data stays available to the caller.
 */
export function formatCommandResult(result, { indent = 2 } = {}) {
  if (result == null) return [];
  if (typeof result === 'string') return expandLine(result, indent);

  const out = [];
  for (const line of result.lines || []) out.push(...expandLine(line, indent));
  if (result.message) out.push(...expandLine(result.message, indent));
  if (out.length > 0) return out;

  const payload = payloadOf(result);
  if (!payload) return [];
  return prettyPrintJson(payload, { indent }).split('\n');
}
