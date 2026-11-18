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
const FILE_TAG_RE = /^\s*<file\s+relative_path="([^"]*)"(?:\s+from=(\d+)\s+to=(\d+))?\s+lines=([^\s>]+)\s*>\s*$/;
const FILE_END_RE = /^\s*<\/file>\s*$/;

/** Blessed parses `{...}` as tags, so braces in untrusted text must be escaped. */
function escapeTags(text) {
  return text.replace(/[{}]/g, (ch) => (ch === '{' ? '{open}' : '{close}'));
}

/** Inline markup: **bold** and `code` (input is already sanitized + escaped). */
function inlineMarkup(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '{bold}$1{/bold}')
    .replace(/`([^`]+)`/g, '{cyan-fg}$1{/cyan-fg}');
}

/**
 * Minimal markdown-ish renderer for the conversation: fenced code blocks,
 * headings, lists, bold and inline code become neo-blessed tags.
 *
 * Pure (no screen needed) so it can be unit tested without a terminal. It
 * sanitizes first, so raw model output can neither break rendering nor inject
 * tags; braces are escaped for the same reason.
 */
export function formatTranscript(text) {
  const out = [];
  let inFence = false;

  for (const raw of sanitize(text).split('\n')) {
    const fence = raw.match(FENCE_RE);
    if (fence) {
      if (inFence) {
        out.push('{cyan-fg}└─────{/cyan-fg}');
        inFence = false;
      } else {
        inFence = true;
        const lang = fence[1];
        out.push(lang ? `{cyan-fg}┌─ ${escapeTags(lang)} ─{/cyan-fg}` : '{cyan-fg}┌─────{/cyan-fg}');
      }
      continue;
    }

    if (inFence) {
      out.push(`{cyan-fg}│ ${escapeTags(raw)}{/cyan-fg}`);
      continue;
    }

    const file = raw.match(FILE_TAG_RE);
    if (file) {
      const [, filePath, from, to, lines] = file;
      const range = from && to ? ` from=${from} to=${to}` : '';
      out.push(`{cyan-fg}┌─ ${escapeTags(filePath)}${range} · lines=${escapeTags(lines)}{/cyan-fg}`);
      continue;
    }
    if (FILE_END_RE.test(raw)) {
      out.push('{cyan-fg}└─────{/cyan-fg}');
      continue;
    }

    const line = escapeTags(raw);
    const heading = line.match(HEADING_RE);
    if (heading) {
      out.push(`{bold}{underline}${inlineMarkup(heading[2])}{/underline}{/bold}`);
      continue;
    }

    const list = line.match(LIST_RE);
    if (list) {
      out.push(`${list[1]}{green-fg}•{/green-fg} ${inlineMarkup(list[2])}`);
      continue;
    }

    out.push(inlineMarkup(line));
  }

  if (inFence) out.push('{cyan-fg}└─────{/cyan-fg}');
  return out.join('\n');
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
  const total = Number(width) || 0;

  if (total <= 0) return [leftText, rightText].filter(Boolean).join(' ');
  if (!rightText) return leftText;
  if (!leftText) {
    return rightText.length >= total ? rightText : ' '.repeat(total - rightText.length) + rightText;
  }

  const gap = total - leftText.length - rightText.length;
  if (gap > 0) return `${leftText}${' '.repeat(gap)}${rightText}`;

  const keep = Math.max(0, total - rightText.length - 1);
  return `${leftText.slice(0, keep)} ${rightText}`;
}

/** Paste tag written into the input when a large block is collapsed. */
export const PASTE_THRESHOLD = 4;

const PASTE_TAG_RE = /\[\[paste:(\d+)\]\]/g;

/**
 * Collapse a pasted block longer than `threshold` lines into one `[[paste:<id>]]`
 * tag. The original bytes are kept verbatim in `pastes`, so expandPastes() can
 * restore them exactly (round-trip safe).
 */
export function collapsePaste(text, threshold = PASTE_THRESHOLD, pastes = []) {
  const source = String(text ?? '');
  if (source.split('\n').length <= threshold) return { text: source, pastes };
  const id = pastes.length;
  return { text: `[[paste:${id}]]`, pastes: [...pastes, source] };
}

/** Expand `[[paste:<id>]]` tags back to the exact bytes they were collapsed from. */
export function expandPastes(text, pastes = []) {
  return String(text ?? '').replace(PASTE_TAG_RE, (match, id) => {
    const original = pastes[Number(id)];
    return typeof original === 'string' ? original : match;
  });
}
