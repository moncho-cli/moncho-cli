import { colorizeLines, USER_ECHO_HEADER } from './theme.js';
import { displayWidth, clustersWithin } from './cell-width.js';
import { tableAt } from './markdown-table.js';// The paste round trip lives in its own module (`app/paste-tags.js`); re-exported here
// because this is where every caller and test already reaches for it.
export { PASTE_THRESHOLD, collapsePaste, expandPastes } from './paste-tags.js';

/**
 * Pure text helpers for the TUI: sanitising, the markdown-ish transcript
 * renderer, paste collapsing and the status-row layout.
 *
 * Deliberately free of neo-blessed (no screen needed), so every rendering rule
 * can be unit tested without a terminal; app/tui.js wires them to the widgets
 * and re-exports them for compatibility.
 */

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Strip ANSI escapes / control characters so raw model output cannot break rendering. */
export function sanitize(text) {
  return String(text ?? '').replace(ANSI_RE, '').replace(CTRL_RE, '');
}

/** console.log-ish argument formatting without pulling in heavier helpers. */
export function formatArg(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

const FENCE_RE = /^\s*```\s*([\w+-]*)\s*$/;
const HEADING_RE = /^\s*(#{1,6})\s+(.*)$/;
const LIST_RE = /^(\s*)[-*+]\s+(.*)$/;
/**
 * The foreground of a quoted line (`│ …`).
 *
 * This one colour serves both quoters, because `formatUserEcho()` writes the user's
 * message as `> ` lines and a markdown blockquote the model wrote arrives the same way:
 * the branch below cannot tell them apart (see `docs/interface/user-messages`).
 *
 * It is **bright white**, the fullest white a terminal has — not `white`, which
 * neo-blessed renders as the ordinary 16-colour white and reads as light grey. It was
 * green, which did not read as a quotation; on the user's blue band it also sat close to
 * the tool palette's write green.
 *
 * The value is a **palette key** now (`quote` in `app/theme-palette.js`): the renderer
 * emits `{@quote-fg}` and `app/paint-tags.js` resolves it at paint time, so a skin moves
 * a quote with everything else. This constant is the shipped default, which is what a
 * skin-less project paints.
 */
export const QUOTE_COLOR = 'bright-white';
/** A quoted line: what formatUserEcho() produces, and a markdown blockquote. */
const QUOTE_RE = /^\s*>\s?(.*)$/;

/** Delimiters emitted by the discovery/read tools (tools/*.js). */
const FILE_TAG_RE = /^\s*<file\s+relative_path="([^"]*)"(?:\s+from=(\d+)\s+to=(\d+))?\s+lines=([^\s>]+)\s*>\s*$/;
const FILE_END_RE = /^\s*<\/file>\s*$/;
const GREP_TAG_RE = /^\s*<grep\s+pattern="([^"]*)"\s+path="([^"]*)"\s+matches=(\d+)\s+files=(\d+)/;
const GREP_END_RE = /^\s*<\/grep>\s*$/;
const BLOBS_TAG_RE = /^\s*<blobs\s+path="([^"]*)"\s+count=(\d+)\s+bytes=(\d+)/;
const BLOBS_END_RE = /^\s*<\/blobs>\s*$/;
const BLOB_TAG_RE = /^\s*<blob\s+path="([^"]*)"(?:\s+bytes=(\d+)\s+lines=(\d+)|\s+skipped="([^"]*)")?/;
const BLOB_END_RE = /^\s*<\/blob>\s*$/;
const HINT_TAG_RE = /^\s*<hint\s+path="([^"]*)"(?:\s+from=(\d+)\s+to=(\d+))?\s+lines=([^\s>]+)\s+chars=(\d+)\s+of=(\d+)/;
const HINT_END_RE = /^\s*<\/hint>\s*$/;

/** Blessed parses `{...}` as tags, so braces in untrusted text must be escaped. */
export function escapeTags(text) {
  return text.replace(/[{}]/g, (ch) => (ch === '{' ? '{open}' : '{close}'));
}

/** Inline markup: **bold** and `code` (input is already sanitized + escaped). */
function inlineMarkup(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '{bold}$1{/bold}')
    .replace(/`([^`]+)`/g, '{@code-fg}$1{/@code-fg}');
}

/** A `truncated=true` attribute on a tool tag becomes a short suffix. */
function truncationSuffix(raw) {
  return /truncated=true/.test(raw) ? ' · truncated' : '';
}

/**
 * Render one tool-result delimiter line as a header, or null when the line is not
 * a delimiter. Keeps the tag vocabulary in one place so read_file, grep and blob
 * all look the same in the transcript.
 */
function renderDelimiter(raw) {
  const file = raw.match(FILE_TAG_RE);
  if (file) {
    const [, filePath, from, to, lines] = file;
    const range = from && to ? ` from=${from} to=${to}` : '';
    return `{@frame-fg}┌─ ${escapeTags(filePath)}${range} · lines=${escapeTags(lines)}{/@frame-fg}`;
  }
  if (FILE_END_RE.test(raw)) return '{@frame-fg}└─────{/@frame-fg}';

  // A hint is a read too (same family, same cyan), but the header says "hint" and
  // reports the characters saved, so a sketch can never read as exact bytes.
  const hint = raw.match(HINT_TAG_RE);
  if (hint) {
    const [, hintPath, from, to, lines, chars, of] = hint;
    const range = from && to ? ` from=${from} to=${to}` : '';
    return `{@frame-fg}┌─ hint ${escapeTags(hintPath)}${range}`
      + ` · lines=${escapeTags(lines)} · ${chars}/${of} chars${truncationSuffix(raw)}{/@frame-fg}`;
  }
  if (HINT_END_RE.test(raw)) return '{@frame-fg}└─────{/@frame-fg}';

  const grep = raw.match(GREP_TAG_RE);
  if (grep) {
    const [, pattern, grepPath, matches, files] = grep;
    return `{@frame-fg}┌─ grep /${escapeTags(pattern)}/ in ${escapeTags(grepPath)}`
      + ` · ${matches} matches in ${files} files${truncationSuffix(raw)}{/@frame-fg}`;
  }
  if (GREP_END_RE.test(raw)) return '{@frame-fg}└─────{/@frame-fg}';

  const blobs = raw.match(BLOBS_TAG_RE);
  if (blobs) {
    const [, blobsPath, count, bytes] = blobs;
    return `{@frame-fg}┌─ blobs ${escapeTags(blobsPath)} · ${count} files · ${bytes} bytes`
      + `${truncationSuffix(raw)}{/@frame-fg}`;
  }
  if (BLOBS_END_RE.test(raw)) return '{@frame-fg}└─────{/@frame-fg}';

  const blob = raw.match(BLOB_TAG_RE);
  if (blob) {
    const [, blobPath, bytes, lines, skipped] = blob;
    const label = skipped
      ? `skipped (${escapeTags(skipped)})`
      : `${lines} lines · ${bytes} bytes${truncationSuffix(raw)}`;
    return `{@frame-fg}├─ ${escapeTags(blobPath)} · ${label}{/@frame-fg}`;
  }
  if (BLOB_END_RE.test(raw)) return null;

  return null;
}

/**
 * Minimal markdown-ish renderer for the conversation: fenced code blocks, tables,
 * tool delimiters, headings, lists, bold and inline code become neo-blessed tags.
 *
 * Pure (no screen needed) so it can be unit tested without a terminal. It
 * sanitizes first, so raw model output can neither break rendering nor inject
 * tags; braces are escaped for the same reason.
 *
 * The palette is applied **separately**, by `formatTranscript()` below, and that split
 * is what lets a skin repaint a conversation that is already on screen: the view keeps
 * these uncoloured lines as each entry's `source` and re-colours them at paint time
 * (`docs/interface/skins`). Fold the two back together and applying a skin would move
 * only the chrome, leaving every row on screen in the colour it was written with.
 */
export function renderTranscriptLines(text) {
  const out = [];
  let inFence = false;
  const lines = sanitize(text).split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const fence = raw.match(FENCE_RE);
    if (fence) {
      if (inFence) {
        out.push('{@frame-fg}└─────{/@frame-fg}');
        inFence = false;
      } else {
        inFence = true;
        const lang = fence[1];
        out.push(lang ? `{@frame-fg}┌─ ${escapeTags(lang)} ─{/@frame-fg}` : '{@frame-fg}┌─────{/@frame-fg}');
      }
      continue;
    }

    if (inFence) {
      out.push(`{@frame-fg}│ ${escapeTags(raw)}{/@frame-fg}`);
      continue;
    }

    const delimiter = renderDelimiter(raw);
    if (delimiter !== null) {
      out.push(delimiter);
      continue;
    }

    // A markdown table is consumed whole: its header, its delimiter row and its body
    // are re-laid so every column lines up (`app/markdown-table.js`). Inline markup is
    // applied per cell *before* the widths are measured, so `**bold**` costs no column.
    const table = tableAt(lines, index, { decorate: (cell) => inlineMarkup(escapeTags(cell)) });
    if (table) {
      out.push(...table.lines);
      index = table.end;
      continue;
    }

    const line = escapeTags(raw);
    const quote = line.match(QUOTE_RE);
    if (quote) {
      out.push(`{@quote-fg}│ ${inlineMarkup(quote[1])}{/@quote-fg}`);
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      out.push(`{@heading-fg}{bold}{underline}${inlineMarkup(heading[2])}{/underline}{/bold}{/@heading-fg}`);
      continue;
    }

    const list = line.match(LIST_RE);
    if (list) {
      out.push(`${list[1]}{@bullet-fg}•{/@bullet-fg} ${inlineMarkup(list[2])}`);
      continue;
    }

    out.push(inlineMarkup(line));
  }

  if (inFence) out.push('{@frame-fg}└─────{/@frame-fg}');
  return out;
}

/**
 * The rendered transcript, painted with the palette in force **right now**.
 *
 * The conversation palette (app/theme.js) paints the *kind* of each row — the user's
 * echo, tool calls and results, context notices, errors — while leaving every line the
 * renderer above already coloured exactly as it is.
 */
export function formatTranscript(text) {
  return colorizeLines(renderTranscriptLines(text)).join('\n');
}

export { USER_ECHO_HEADER };

/** Prefix quoting every line of an echoed user message. */
export const USER_ECHO_PREFIX = '> ';

/**
 * Render the user's own message for the conversation view: a `You:` header plus
 * every line quoted with `> `, which formatTranscript() paints as a coloured
 * quote. Presentation only — the message the model receives is the chunk itself.
 */
export function formatUserEcho(text) {
  const lines = sanitize(text).split('\n');
  return [USER_ECHO_HEADER, ...lines.map((line) => `${USER_ECHO_PREFIX}${line}`)].join('\n');
}
/**
 * Lay out one status row: `left` (status text or spinner frame) starts at the
 * left edge, `right` (the context-window meter) is pinned to the right edge of
 * `width`, padded with spaces in between.
 *
 * Pure, so the layout is unit tested without a terminal. When there is not
 * enough room the left side is truncated, never the meter: the usage is the
 * information that must stay visible.
 */
export function composeStatusRow(left = '', right = '', width = 0) {
  const leftText = String(left ?? '');
  const rightText = String(right ?? '');
  // Width is counted in **cells**, not code units: a wide glyph (an emoji in the
  // status text, a CJK character) covers two columns, so padding by `.length` leaves
  // the meter a cell short of the right edge on a row carrying one.
  const rightCells = displayWidth(rightText);
  const total = Number(width) || 0;

  if (total <= 0) return [leftText, rightText].filter(Boolean).join(' ');
  if (!rightText) return leftText;
  if (!leftText) {
    return rightCells >= total ? rightText : ' '.repeat(total - rightCells) + rightText;
  }

  const gap = total - displayWidth(leftText) - rightCells;
  if (gap > 0) return `${leftText}${' '.repeat(gap)}${rightText}`;

  // The left text is cut **between clusters**, so a truncation never ends on half of
  // a character (which a terminal would paint as a replacement glyph).
  const keep = Math.max(0, total - rightCells - 1);
  return `${clustersWithin(leftText, keep).join('')} ${rightText}`;
}

