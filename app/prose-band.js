import { padVisible } from './tagged-text.js';

export { padVisible };

/**
 * The background band a block of prose is painted in.
 *
 * A screenful of transcript is mostly undifferentiated text, so the two sides of the
 * dialogue are hard to pick out of it (task-backlog: "both user message and model
 * prose chunks in the TUI should have like a nice background (different color for
 * each) with 1 line margin top and bottom, so are easier to read in between all the
 * text"). This module owns that band and nothing else.
 *
 * Three rules make it safe to compose with the palette and the markdown renderer
 * (`docs/interface/conversation-colors`, `docs/interface/tui`):
 *
 *  - **background only.** The band never touches the foreground, so the colours a
 *    row already carries — a cyan `You:`, a green quote, a bold heading — stay
 *    exactly as they were and stay readable over the band.
 *  - **one colour per side, and only two sides.** `user` and `assistant` are the
 *    roles the band knows; every other role (a notice, a tool result, the model's
 *    tracking rows) is returned **untouched**, so a band can never be applied by
 *    accident to a row that is not prose.
 *  - **the band is padded, not filled by the widget.** The line is padded to the
 *    region's inner width *inside* the tag, so the whole row is coloured even where
 *    there is no text — which is what the one-line margin above and below the block
 *    is made of. A line already wider than the region is left for blessed to wrap.
 *
 * Pure and terminal-free: the caller passes the width, so both rules are unit tested
 * without a screen. The band is presentation only — it lives on a display line, never
 * on a context chunk or a session file, and the line CLI never renders one.
 */

/** The two sides of the dialogue, and the only roles a band knows. */
export const PROSE_BANDS = Object.freeze(['user', 'assistant']);

/**
 * One blessed background colour per side, so "what I asked" and "what the agent
 * answered" never read alike. Both are the *dark* form of a colour, because the band
 * sits under the whole foreground palette (`app/theme.js`) and every row painted on it
 * has to stay legible.
 *
 * `red` is the ANSI dark red (`\x1b[41m`). It replaced `yellow` (dark yellow, `\x1b[43m`),
 * which read as muddy; `grey` was the first colour and was simply wrong, resolving to
 * bright black (`\x1b[100m`), all but the default background on a dark terminal.
 *
 * A band can never make a colour collision the reader has to resolve: red is also the
 * palette's *error* foreground, but an error, a refusal or any other row that is not one
 * of the two sides is never banded (`bandLine()` returns it byte-for-byte), so no red
 * foreground is ever painted on the red band.
 */
export const BAND_BACKGROUNDS = Object.freeze({
  user: 'blue',
  assistant: 'red',
});

/** True for a role a band is defined for. */
export function isBandRole(role) {
  return PROSE_BANDS.includes(role);
}

/** The blessed background colour name for a role, or null for anything else. */
export function bandColor(role) {
  return isBandRole(role) ? BAND_BACKGROUNDS[role] : null;
}

/**
 * Paint one display line as a full-width band, or return it byte-for-byte when its
 * role has no band (plain text, notices, the payload of a tool result).
 */
export function bandLine(line, role, width = 0) {
  const color = bandColor(role);
  if (!color) return String(line ?? '');
  return `{${color}-bg}${padVisible(line, width)}{/${color}-bg}`;
}

/** The blank banded row that gives a band its one-line top or bottom margin. */
export function bandMargin(role, width = 0) {
  return bandLine('', role, width);
}

/**
 * Take a trailing `{ role }` argument off a `log()`-style call, if it is one.
 *
 * The role names the side of the dialogue, and every other object a caller logs is
 * *content* (turned into text by the caller). Recognising it here keeps that rule in
 * one place instead of in every front end's log implementation.
 *
 * A trailing object may also carry `stamp`: the mark a **replayed** entry shows, taken
 * from the time the record stored for that chunk instead of from the clock
 * (`docs/interface/session-stamps`). It rides beside the role rather than inside the
 * text, so no row's own bytes are rewritten to carry it.
 *
 * @param {Array} args the logged arguments; a trailing `{ role, stamp }` is the options object
 */
export function takeBandOptions(args = []) {
  const list = Array.isArray(args) ? args : [];
  const last = list[list.length - 1];
  if (last && typeof last === 'object' && !Array.isArray(last)
    && (isBandRole(last.role) || typeof last.stamp === 'string')) {
    list.pop();
    return { role: last.role, stamp: last.stamp ?? null };
  }
  return {};
}

/** True when an entry is already a blank banded row — a margin, not content. */
export function isBlankBand(entry) {
  return Boolean(entry)
    && entry.type === 'line'
    && isBandRole(entry.role)
    && String(entry.text).trim() === '';
}

/**
 * The width a banded line may use: exactly what the widget wraps to.
 *
 * That is the region's interior (`width - iwidth`) less the cell blessed reserves for
 * the scrollbar and the one it reserves for a textarea (`lib/widgets/element.js`:
 * `if (this.scrollbar) margin++; if (this.type === 'textarea') margin++`). A band
 * padded one cell past it wraps into a second row, which shifts every row below it and
 * breaks the row-to-block map the block click reads, so the number has to be blessed's
 * own and not a generous approximation.
 */
export function bandWidthOf(widget) {
  if (!widget) return 0;
  const outer = Number(widget.width) || 0;
  const inner = Number(widget.iwidth) || 0;
  const margin = (widget.scrollbar ? 1 : 0) + (widget.type === 'textarea' ? 1 : 0);
  return Math.max(0, outer - inner - margin);
}

/** Paint a whole model as content: one banded line per record, in order. */
export function composeBanded(records = [], width = 0) {
  return records
    .map((record) => bandLine(record?.text, record?.role, width))
    .join('\n');
}
