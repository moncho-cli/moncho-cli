/**
 * The conversation palette (task-backlog: "conversation needs colors to be
 * easier to read").
 *
 * A transcript row means different things — the prompt the user typed, a tool
 * call, a tool result, a context notice, an error — and on a monochrome screen
 * they all look alike. This module names one colour per *kind* of row and paints
 * a row with a neo-blessed tag.
 *
 * Pure and terminal-free: it works on already-rendered display lines (the output
 * of `formatTranscript()`, whose braces are escaped) and returns strings, so the
 * classification and the palette are unit testable without a screen.
 *
 * Two rules make it safe to compose with the markdown renderer:
 *  - a line the renderer already coloured (it starts with a blessed tag) is
 *    returned **untouched**, so fences, delimiters, quotes, headings and inline
 *    code keep the colours `formatTranscript()` gave them;
 *  - it only ever *wraps* a line, never rewrites it, so the visible glyphs — and
 *    therefore the block-click row math — are unchanged.
 *
 * Colour is presentation only: it never reaches the model context or a session
 * file, and only the TUI applies it (the line CLI prints through `console.log`).
 */

/** Marker introducing an echoed user message; it is what identifies a user row. */
export const USER_ECHO_HEADER = 'You:';

/** One colour name (a blessed tag colour) per kind of transcript row. */
export const CONVERSATION_COLORS = Object.freeze({
  /** the `You:` header of the echoed prompt */
  user: 'cyan',
  /** a tool call, its intent and a tool result header */
  tool: 'yellow',
  /** `[Context]` notices: usage and compaction */
  context: 'magenta',
  /** errors and warnings */
  error: 'red',
  /** low-key chrome: `[Info]`, `[Session]`, `[pasted …]`, horizontal rules */
  notice: 'grey',
});

/** A line the markdown renderer already tagged (fences, delimiters, quotes…). */
const ALREADY_TAGGED = /^\{(?:bold|underline|inverse|blink|invisible|[a-z]+-bg|[a-z]+-fg)/;

/** The tool-call / tool-result header main.js and the conversation loop emit. */
const TOOL_HEADER = /\[[\w.-]+ Output\]/;

/** The loop's "-> Calling tool(args)" line and the "intent:" line under it. */
const CALLING_LINE = /^\s*->\s*Calling\s/;
const INTENT_LINE = /^\s*intent:\s/;

/** A block header, as app/transcript.js paints it. */
const BLOCK_HEADER = /^\s*[▸▾]/;

/** A horizontal rule (`--- AI Response ---`, `----------------------`). */
const RULE = /^\s*-{3,}/;

/** True when a previous renderer already put a blessed tag on this line. */
export function isTagged(line) {
  return ALREADY_TAGGED.test(String(line ?? ''));
}

/**
 * The kind of one display line, or `null` for plain prose (which gets no colour:
 * markdown colouring and the terminal default are enough for it).
 *
 * Ordered most specific first: an `[error]` line stays red even though a tool
 * result may also look like a tool line, and the `You:` header is recognised
 * before the generic notice rules.
 */
export function classifyLine(line) {
  const text = String(line ?? '');
  if (text.trim() === '') return null;
  if (isTagged(text)) return null;

  if (/^\s*\[error\]/i.test(text) || /^Error\b/.test(text) || text.includes('⚠️')) return 'error';
  // the echo header is exactly `You:` on a line of its own (formatUserEcho)
  if (text === USER_ECHO_HEADER) return 'user';
  if (BLOCK_HEADER.test(text) || TOOL_HEADER.test(text) || CALLING_LINE.test(text)) return 'tool';
  if (INTENT_LINE.test(text)) return 'tool';
  if (/^\s*\[Context\]/.test(text)) return 'context';
  if (/^\s*\[(?:Info|Session)\]/.test(text) || /^\s*\[pasted\b/.test(text) || RULE.test(text)) return 'notice';
  return null;
}

/** Wrap one line in its blessed tag, or return it unchanged when it has none. */
export function colorizeLine(line) {
  const text = String(line ?? '');
  const kind = classifyLine(text);
  if (!kind) return text;
  const color = CONVERSATION_COLORS[kind];
  return `{${color}-fg}${text}{/${color}-fg}`;
}

/** Colour a whole transcript: one output line per input line, in order. */
export function colorizeLines(lines = []) {
  return [...lines].map((line) => colorizeLine(line));
}
