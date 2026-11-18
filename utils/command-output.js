/**
 * The shape of a command result (task-backlog: "the stdout on bash commands, formatted
 * inside a json, cannot be properly truncated as one would use pipe + head/tail. so maybe
 * bash responses should be a yaml header and the stdout after, and it be possible to pass
 * head/tail parameters").
 *
 * A command answers as a **document**: a small YAML header (what ran, where, the exit
 * code, how much output there was and how much of it is shown), a `---` delimiter, and
 * then the stdout verbatim. A model can therefore read the head of a long output, read
 * its tail, or read the whole thing — without a shell, and without the header ever
 * getting in the way of the payload.
 *
 * Pure text work: no `fs`, no child process, no terminal. The window arithmetic, the
 * YAML scalar quoting and the document layout are unit tested on plain strings.
 */

/** Raised when a window request cannot be honoured (both ends, or a nonsense count). */
export class OutputRangeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OutputRangeError';
    this.code = code;
  }
}

/** A line count: a positive integer, or null when the caller did not ask for it. */
function toLineCount(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new OutputRangeError('INVALID_RANGE', `"${name}" must be a whole number of lines, got ${JSON.stringify(value)}.`);
  }
  if (parsed < 1) {
    throw new OutputRangeError('INVALID_RANGE', `"${name}" must be at least 1 line, got ${parsed}.`);
  }
  return parsed;
}

/**
 * Decide which slice of the output to show.
 *
 * `head` and `tail` are mutually exclusive — asking for both is `INVALID_RANGE`, never a
 * silent guess — and neither is required: with no window the whole output is returned and
 * `truncated` is false.
 *
 * @param {{head?: number, tail?: number, total: number}} options
 * @returns {{mode: 'all'|'head'|'tail', start: number, end: number, shown: number, total: number, truncated: boolean, count: number|null}}
 */
export function resolveWindow({ head, tail, total } = {}) {
  const count = Math.max(0, Math.trunc(Number(total)) || 0);
  const headCount = toLineCount(head, 'head');
  const tailCount = toLineCount(tail, 'tail');

  if (headCount !== null && tailCount !== null) {
    throw new OutputRangeError('INVALID_RANGE', 'Ask for either "head" or "tail", not both: they select opposite ends of the output.');
  }

  if (headCount !== null) {
    const shown = Math.min(headCount, count);
    return { mode: 'head', start: 0, end: shown, shown, total: count, truncated: count > shown, count: headCount };
  }
  if (tailCount !== null) {
    const shown = Math.min(tailCount, count);
    return { mode: 'tail', start: count - shown, end: count, shown, total: count, truncated: count > shown, count: tailCount };
  }
  return { mode: 'all', start: 0, end: count, shown: count, total: count, truncated: false, count: null };
}

/** The lines of captured output, with a single trailing newline ignored. */
export function splitOutputLines(text) {
  const raw = String(text ?? '');
  if (raw === '') return [];
  return (raw.endsWith('\n') ? raw.slice(0, -1) : raw).split('\n');
}

/**
 * Apply a `head`/`tail` window to captured output.
 *
 * @returns {{text: string, lines: string[], total: number, shown: number, truncated: boolean, mode: string}}
 */
export function windowLines(text, { head, tail } = {}) {
  const lines = splitOutputLines(text);
  const window = resolveWindow({ head, tail, total: lines.length });
  const selected = lines.slice(window.start, window.end);
  return {
    text: selected.join('\n'),
    lines: selected,
    total: window.total,
    shown: window.shown,
    truncated: window.truncated,
    mode: window.mode
  };
}

/** Values YAML reads as something other than the string they look like. */
const YAML_KEYWORD = /^(?:true|false|null|~|yes|no|on|off|[-+]?\d[\d_]*(?:\.\d+)?)$/i;
const YAML_PLAIN = /^[A-Za-z0-9./][A-Za-z0-9._/@+ -]*$/;

/**
 * Render one YAML scalar.
 *
 * A plain word stays plain (`cwd: .`, `mode: head`) so the header reads like a header;
 * anything ambiguous — empty, numeric-looking, keyword-like, or carrying punctuation
 * YAML would interpret (a colon, a quote, a newline) — is double-quoted with JSON
 * escaping, which is a valid YAML double-quoted scalar too.
 */
export function yamlScalar(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);

  const text = String(value ?? '');
  if (text !== '' && YAML_PLAIN.test(text) && !YAML_KEYWORD.test(text)) return text;
  return JSON.stringify(text);
}

/**
 * Render the YAML header of a command document: one `key: value` line per field, in the
 * order given, so the layout is stable and diffable.
 */
export function renderYamlHeader(fields = {}) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}: ${yamlScalar(value)}`)
    .join('\n');
}

/** The delimiter between a command's header and its payload. */
export const OUTPUT_DELIMITER = '---';

/** What the payload says when the command produced nothing at all. */
export const EMPTY_OUTPUT = '(no output)';

/**
 * Lay out a successful command result: the YAML header, the `---` delimiter, then the
 * stdout window. The header always says how many lines there were and how many are
 * shown, so a truncated payload is never mistaken for a complete one.
 */
export function renderCommandOutput({
  command,
  cwd,
  exitCode = 0,
  stdout = '',
  total = 0,
  shown = 0,
  truncated = false,
  mode = 'all',
  head,
  tail
} = {}) {
  const header = renderYamlHeader({
    status: 'success',
    command,
    cwd,
    exit_code: exitCode,
    lines: total,
    shown,
    truncated,
    mode,
    head,
    tail
  });
  const body = shown > 0 ? String(stdout) : EMPTY_OUTPUT;
  return `${header}\n${OUTPUT_DELIMITER}\n${body}`;
}
