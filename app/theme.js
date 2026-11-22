import { STAMP_RE } from './transcript-stamp.js';
import { toolColorFor, toolNameOf } from './tool-palette.js';
import { REFUSAL_LINE_RE } from './refusal-line.js';
import { fgTag, resolveTags } from './paint-tags.js';
import {
  CONVERSATION_COLORS, USER_ECHO_HEADER,
  colorizeIntent, colorizeTracking, colorizeRefusal, colorizeStamp,
} from './theme-palette.js';

// The palette and the presentation tokens are **live state** and live in
// ./theme-palette.js (`docs/interface/skins`): one colour per kind of row, the slash
// band, the tokens a skin may move, and the setters that mutate them in place. They are
// re-exported here because this is the path every colour consumer and every spec already
// uses, so a skin repaints the transcript without an import changing anywhere.
export {
  CONVERSATION_COLORS, SLASH_COLORS, THEME_TOKENS, PROSE_BACKGROUNDS,
  USER_ECHO_HEADER, INTENT_COLOR, INTENT_BOLD, TRACKING_COLOR, TRACKING_BOLD,
  STAMP_COLOR, REFUSAL_COLOR, REFUSAL_BOLD,
  DEFAULT_CONVERSATION_COLORS, isColorName,
  activePalette, activeTokens, setPalette, setTokens, applySkin, resetTheme,
  activeSkinName, markSkinBootstrapped, isSkinBootstrapped, restoreSkinName,
  colorizeIntent, colorizeTracking, colorizeRefusal, colorizeStamp,
} from './theme-palette.js';

/**
 * The conversation palette (task-backlog: "conversation needs colors to be easier to
 * read"; "the color of the intent text should be a brightish blue so is easier to find
 * within the text, and bold").
 *
 * A transcript row means different things — the prompt the user typed, a tool call, the
 * reason for that call, a tool result, a context notice, an error — and on a monochrome
 * screen they all look alike. This module names one colour per *kind* of row and paints a
 * row with a neo-blessed tag; the colours themselves are the live palette of
 * ./theme-palette.js, so a project skin (`docs/interface/skins`) can move them.
 *
 * Pure and terminal-free: it works on already-rendered display lines (the output of
 * `formatTranscript()`, whose braces are escaped) and returns strings, so the
 * classification is unit testable without a screen.
 *
 * Four rules make it safe to compose with the markdown renderer and with the per-entry
 * timestamps:
 *  - a line the renderer already coloured (it starts with a blessed tag) is returned
 *    **untouched**, so fences, delimiters, quotes, headings and inline code keep the
 *    colours `formatTranscript()` gave them;
 *  - it only ever *wraps* a line, never rewrites it, so the visible glyphs — and therefore
 *    the block-click row math — are unchanged;
 *  - the intent of a call is highlighted **inside** whatever row carries it
 *    (`highlightIntentSpans`), so a tool header keeps the colour of its own family
 *    (`app/tool-palette.js`) and only the reason for the call stands out;
 *  - a leading `HH:MM:SS` stamp is *seen through* (`splitStamp`): a stamped `You:` row is
 *    still the user's echo, a stamped tool header is still a tool row, and the stamp itself
 *    is painted in the low-key chrome colour rather than in the colour of the row it
 *    introduces.
 *
 * Colour is presentation only: it never reaches the model context or a session file, and
 * only the TUI applies it (the line CLI prints through `console.log`).
 */

/** A line the markdown renderer already tagged (fences, delimiters, quotes…). */
const ALREADY_TAGGED = /^\{(?:bold|underline|inverse|blink|invisible|[a-z-]+-bg|[a-z-]+-fg)/;
/** The tool-call / tool-result header main.js and the conversation loop emit. */
const TOOL_HEADER = /\[[\w.-]+ Output\]/;

/** The loop's "-> Calling tool(args)" line and the "intent:" line under it. */
const CALLING_LINE = /^\s*->\s*Calling\s/;
const INTENT_LINE = /^\s*intent:\s/;

/**
 * The two shapes the reason for a call takes *inside* a row that already has a colour: the
 * `(intent: …)` span of a `[<tool> Output]` header, and the `intent: …` tail of a
 * `-> Calling name(args, intent: …)` line. Each span ends at the `)` / `,` that closes it,
 * so highlighting one never swallows the rest of the row.
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
 * The stamp is *decoration in front of* a row, not part of it, so classification has to
 * look past it: `12:04:07 You:` is the user's echo and not plain prose. A line with no
 * stamp answers `{ stamp: '', rest: line }`, so every rule below is unchanged for the
 * unstamped case (the line CLI, the pure view tests, a replay).
 */
export function splitStamp(line) {
  const text = String(line ?? '');
  if (!STAMP_RE.test(text)) return { stamp: '', rest: text };
  const cut = text.indexOf(' ');
  return { stamp: text.slice(0, cut), rest: text.slice(cut + 1) };
}

/**
 * Paint only the intent span of a line that keeps another colour around it: a tool header
 * keeps the colour of its own family (app/tool-palette.js), an error row stays red, and the
 * `(intent: …)` / `, intent: …` part turns bright blue and bold. A line without a span comes
 * back byte-for-byte, so the rule is safe to apply to every kind of row.
 */
export function highlightIntentSpans(line) {
  const text = String(line ?? '');
  if (!HAS_INTENT_SPAN.test(text)) return text;
  return text
    .replace(INTENT_PAREN, (span) => colorizeIntent(span))
    .replace(INTENT_TAIL, (span) => `, ${colorizeIntent(span.replace(/^,\s*/, ''))}`);
}

/**
 * True when a previous renderer already put a blessed tag on this line.
 *
 * A **symbolic** tag (`{@frame-fg}`) is not a colour yet: it is a promise that
 * `resolveTags()` will paint it from the live palette at paint time, so a line starting
 * with one is *not* "already coloured" and still belongs to the palette's own layer.
 * Treating it as tagged was what let a render site freeze a colour at render time.
 */
export function isTagged(line) {
  const text = String(line ?? '');
  if (text.startsWith('{@')) return false;
  return ALREADY_TAGGED.test(text);
}

/**
 * The kind of one display line, or `null` for plain prose (which gets no colour: markdown
 * colouring and the terminal default are enough for it).
 *
 * Ordered most specific first: an `[error]` line stays red even though a tool result may
 * also look like a tool line, the `You:` header is recognised before the generic notice
 * rules, and the standalone `intent:` row is matched before the generic tool shapes so the
 * reason for a call gets its own colour. A leading timestamp is looked past first, so it
 * never hides the kind of the row it marks.
 */
export function classifyLine(line) {
  const { rest } = splitStamp(line);
  if (rest.trim() === '') return null;
  if (isTagged(rest)) return null;

  // The refusal row comes first: it is the palette's own marker plus a verb, and a reason
  // that happens to mention an error must not repaint it as one.
  if (REFUSAL_LINE_RE.test(rest)) return 'refusal';
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
 * A stamp is painted separately and in the chrome colour, so the timestamp never borrows
 * the colour of the row it introduces; the row's own kind then decides the colour of what
 * follows it, exactly as it would without a stamp.
 */
export function colorizeLine(line) {
  const text = String(line ?? '');
  const { stamp, rest } = splitStamp(text);
  const prefix = colorizeStamp(stamp);
  const kind = classifyLine(text);
  // No kind: the line keeps whatever the markdown renderer gave it — but a stamp in front
  // of it is chrome and is still painted as such.
  if (!kind) {
    // A symbolic tag (`{@frame-fg}`) is painted from the live palette here, at paint
    // time — which is the whole reason a skin can move a fence, a table frame or a
    // quote the markdown renderer wrote (`app/paint-tags.js`, `docs/interface/skins`).
    return resolveTags(stamp ? `${prefix}${rest}` : text, CONVERSATION_COLORS);
  }
  if (kind === 'refusal') return resolveTags(`${prefix}${colorizeRefusal(rest)}`, CONVERSATION_COLORS);
  if (kind === 'intent') return resolveTags(`${prefix}${colorizeIntent(rest)}`, CONVERSATION_COLORS);
  if (kind === 'tracking') return resolveTags(`${prefix}${colorizeTracking(rest)}`, CONVERSATION_COLORS);
  // A tool row is painted by *what the tool does* — reading, writing, running a command
  // (app/tool-palette.js) — so a screenful of tool rows can be skimmed by colour; a row
  // naming no known tool keeps the colour of its kind. The kind colour is passed **live**,
  // so a skin that moves `tool` really repaints an unclassified tool row
  // (`docs/interface/skins`).
  const color = kind === 'tool'
    ? toolColorFor(toolNameOf(rest) ?? '', {
      palette: CONVERSATION_COLORS,
      fallback: CONVERSATION_COLORS.tool,
    })
    : CONVERSATION_COLORS[kind];
  return resolveTags(`${prefix}${fgTag(color, highlightIntentSpans(rest))}`, CONVERSATION_COLORS);
}

/** Colour a whole transcript: one output line per input line, in order. */
export function colorizeLines(lines = []) {
  return [...lines].map((line) => colorizeLine(line));
}
