import { STAMP_RE } from './transcript-stamp.js';

/**
 * The conversation palette (task-backlog: "conversation needs colors to be
 * easier to read"; "the color of the intent text should be a brightish blue so is
 * easier to find within the text, and bold").
 *
 * A transcript row means different things — the prompt the user typed, a tool
 * call, the reason for that call, a tool result, a context notice, an error — and
 * on a monochrome screen they all look alike. This module names one colour per
 * *kind* of row and paints a row with a neo-blessed tag.
 *
 * Pure and terminal-free: it works on already-rendered display lines (the output
 * of `formatTranscript()`, whose braces are escaped) and returns strings, so the
 * classification and the palette are unit testable without a screen.
 *
 * Four rules make it safe to compose with the markdown renderer and with the
 * per-entry timestamps:
 *  - a line the renderer already coloured (it starts with a blessed tag) is
 *    returned **untouched**, so fences, delimiters, quotes, headings and inline
 *    code keep the colours `formatTranscript()` gave them;
 *  - it only ever *wraps* a line, never rewrites it, so the visible glyphs — and
 *    therefore the block-click row math — are unchanged;
 *  - the intent of a call is highlighted **inside** whatever row carries it
 *    (`highlightIntentSpans`), so a yellow tool header keeps its colour and only
 *    the reason for the call stands out;
 *  - a leading `HH:MM:SS` stamp is *seen through* (`splitStamp`): a stamped
 *    `You:` row is still the user's echo, a stamped tool header is still a tool
 *    row, and the stamp itself is painted in the low-key chrome colour rather than
 *    in the colour of the row it introduces.
 *
 * Colour is presentation only: it never reaches the model context or a session
 * file, and only the TUI applies it (the line CLI prints through `console.log`).
 */

/** Marker introducing an echoed user message; it is what identifies a user row. */
export const USER_ECHO_HEADER = 'You:';

/**
 * One colour name (a blessed tag colour) per kind of transcript row.
 *
 * The intent is `bright-blue` rather than the `blue` the terminal calls normal:
 * that blue is dark and disappears against a black background, while the bright
 * variant is the one a reader can pick out inside a yellow tool block. The name is
 * hyphenated because blessed's tag parser rewrites `-` into a space and its colour
 * switch spells the bright variant `bright blue fg`
 * (node_modules/neo-blessed/lib/program.js#_attr): `brightblue` on its own is not
 * a tag name and would be printed literally as `{brightblue-fg}`; the tag name and
 * the escape it paints are asserted in `tests/conversation-colors.test.js` instead.
 */
export const CONVERSATION_COLORS = Object.freeze({
  /** the `You:` header of the echoed prompt */
  user: 'cyan',
  /** a tool call and a `[<tool> Output]` header */
  tool: 'yellow',
  /** the reason for a tool call: the `intent:` row and the `intent:` span */
  intent: 'bright-blue',
  /** `[Context]` notices: usage and compaction */
  context: 'magenta',
  /** errors and warnings */
  error: 'red',
  /** low-key chrome: `[Info]`, `[Session]`, `[pasted …]`, horizontal rules */
  notice: 'grey',
  /** a `[Tracking]` row: a task.md / implementation_plan.md update */
  tracking: 'bright-green',
});

/** The colour the intent is painted in (task-backlog: "a brightish blue"). */
export const INTENT_COLOR = CONVERSATION_COLORS.intent;

/** The attribute, besides the colour, that makes the intent findable. */
export const INTENT_BOLD = true;

/** The colour a tracking update is painted in, so it never reads as a tool row. */
export const TRACKING_COLOR = CONVERSATION_COLORS.tracking;
/** Tracking updates are milestones, so they carry bold as well as the colour. */
export const TRACKING_BOLD = true;

/** The colour a timestamp is painted in: chrome, never the row it introduces. */
export const STAMP_COLOR = CONVERSATION_COLORS.notice;

/** A line the markdown renderer already tagged (fences, delimiters, quotes…). */
const ALREADY_TAGGED = /^\{(?:bold|underline|inverse|blink|invisible|[a-z-]+-bg|[a-z-]+-fg)/;

/** The tool-call / tool-result header main.js and the conversation loop emit. */
const TOOL_HEADER = /\[[\w.-]+ Output\]/;

/** The loop's "-> Calling tool(args)" line and the "intent:" line under it. */
const CALLING_LINE = /^\s*->\s*Calling\s/;
const INTENT_LINE = /^\s*intent:\s/;

/**
 * The two shapes the reason for a call takes *inside* a row that already has a
 * colour: the `(intent: …)` span of a `[<tool> Output]` header, and the `intent: …`
 * tail of a `-> Calling name(args, intent: …)` line. Each span ends at the `)` /
 * `,` that closes it, so highlighting one never swallows the rest of the row.
 */
const INTENT_PAREN = /\(intent:[^)]*\)/;
const INTENT_TAIL = /,\s*intent:[^,)]*/;
const HAS_INTENT_SPAN = /\(intent:|,\s*intent:/;

/** A block header, as app/transcript.js paints it. */
const BLOCK_HEADER = /^\s*[▸▾]/;

/** A horizontal rule (`--- AI Response ---`, `----------------------`). */
const RULE = /^\s*-{3,}/;

/**
 * Split a stamped display line into its timestamp and its content.
 *
 * The stamp is *decoration in front of* a row, not part of it, so classification
 * has to look past it: `12:04:07 You:` is the user's echo and not plain prose. A
 * line with no stamp answers `{ stamp: '', rest: line }`, so every rule below is
 * unchanged for the unstamped case (the line CLI, the pure view tests, a replay).
 */
export function splitStamp(line) {
  const text = String(line ?? '');
  if (!STAMP_RE.test(text)) return { stamp: '', rest: text };
  const cut = text.indexOf(' ');
  return { stamp: text.slice(0, cut), rest: text.slice(cut + 1) };
}

/**
 * One intent, painted the way the backlog asks for it: a bright blue and bold. The
 * colour makes it findable inside the yellow tool block, the bold makes it stand
 * out in a wall of output. Pure: the caller (or the test) gets a blessed tag back
 * as a string, never a screen.
 */
export function colorizeIntent(text) {
  const body = String(text ?? '');
  return `{${INTENT_COLOR}-fg}{bold}${body}{/bold}{/${INTENT_COLOR}-fg}`;
}

/**
 * One tracking update, painted the way a milestone should read: its own bright colour
 * plus bold, so a `[Tracking]` row can never be mistaken for a tool result (yellow) or
 * a context notice (magenta).
 */
export function colorizeTracking(text) {
  const body = String(text ?? '');
  return `{${TRACKING_COLOR}-fg}{bold}${body}{/bold}{/${TRACKING_COLOR}-fg}`;
}

/** One timestamp, painted as chrome: the low-key colour, and never bold. */
export function colorizeStamp(stamp) {
  const body = String(stamp ?? '');
  if (!body) return '';
  return `{${STAMP_COLOR}-fg}${body}{/${STAMP_COLOR}-fg} `;
}

/**
 * Paint only the intent span of a line that keeps another colour around it: a tool
 * header stays yellow, an error row stays red, and the `(intent: …)` /
 * `, intent: …` part turns bright blue and bold. A line without a span comes back
 * byte-for-byte, so the rule is safe to apply to every kind of row.
 */
export function highlightIntentSpans(line) {
  const text = String(line ?? '');
  if (!HAS_INTENT_SPAN.test(text)) return text;
  return text
    .replace(INTENT_PAREN, (span) => colorizeIntent(span))
    .replace(INTENT_TAIL, (span) => `, ${colorizeIntent(span.replace(/^,\s*/, ''))}`);
}

/** True when a previous renderer already put a blessed tag on this line. */
export function isTagged(line) {
  return ALREADY_TAGGED.test(String(line ?? ''));
}

/**
 * The kind of one display line, or `null` for plain prose (which gets no colour:
 * markdown colouring and the terminal default are enough for it).
 *
 * Ordered most specific first: an `[error]` line stays red even though a tool
 * result may also look like a tool line, the `You:` header is recognised before
 * the generic notice rules, and the standalone `intent:` row is matched before the
 * generic tool shapes so the reason for a call gets its own colour. A leading
 * timestamp is looked past first, so it never hides the kind of the row it marks.
 */
export function classifyLine(line) {
  const { rest } = splitStamp(line);
  if (rest.trim() === '') return null;
  if (isTagged(rest)) return null;

  if (/^\s*\[error\]/i.test(rest) || /^Error\b/.test(rest) || rest.includes('⚠️')) return 'error';
  // the echo header is exactly `You:` on a line of its own (formatUserEcho)
  if (rest === USER_ECHO_HEADER) return 'user';
  if (INTENT_LINE.test(rest)) return 'intent';
  if (BLOCK_HEADER.test(rest) || TOOL_HEADER.test(rest) || CALLING_LINE.test(rest)) return 'tool';
  if (/^\s*\[Context\]/.test(rest)) return 'context';
  if (/^\s*\[Tracking\]/.test(rest)) return 'tracking';
  if (/^\s*\[(?:Info|Session)\]/.test(rest) || /^\s*\[pasted\b/.test(rest) || RULE.test(rest)) return 'notice';
  return null;
}

/**
 * Wrap one line in its blessed tag, or return it unchanged when it has none.
 *
 * A stamp is painted separately and in the chrome colour, so the timestamp never
 * borrows the colour of the row it introduces; the row's own kind then decides the
 * colour of what follows it, exactly as it would without a stamp.
 */
export function colorizeLine(line) {
  const text = String(line ?? '');
  const { stamp, rest } = splitStamp(text);
  const prefix = colorizeStamp(stamp);
  const kind = classifyLine(text);
  // No kind: the line keeps whatever the markdown renderer gave it — but a stamp in
  // front of it is chrome and is still painted as such.
  if (!kind) return stamp ? `${prefix}${rest}` : text;
  if (kind === 'intent') return `${prefix}${colorizeIntent(rest)}`;
  if (kind === 'tracking') return `${prefix}${colorizeTracking(rest)}`;
  const color = CONVERSATION_COLORS[kind];
  return `${prefix}{${color}-fg}${highlightIntentSpans(rest)}{/${color}-fg}`;
}

/** Colour a whole transcript: one output line per input line, in order. */
export function colorizeLines(lines = []) {
  return [...lines].map((line) => colorizeLine(line));
}
