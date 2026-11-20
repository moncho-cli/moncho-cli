/**
 * The refusal row: one line saying a call was **refused instead of run**, and the
 * marker that lets the conversation palette recognise it.
 *
 * A leaf module on purpose. It imports nothing, because two very different callers
 * need it and only one of them may reach the rest of the app:
 *
 *  - `app/tool-batch.js` builds the row for both refusal sources — the pre-dispatch
 *    gate (`app/tool-guard.js`) and the batch cap — so the two can never drift apart;
 *  - `app/theme.js` classifies and paints the row, and the palette is deliberately
 *    free of everything else: it is the pure, terminal-free half of the transcript
 *    (`docs/interface/conversation-colors`), applied by `formatTranscript()` on the
 *    paths of the TUI *and* of a plain render. Importing a module that reaches
 *    `config/constants.js` would make the palette read the provider environment at
 *    load time, which is exactly what a rendering helper must never do.
 *
 * So the glyph, the verb and the shape of the row live here, and both sides read
 * them from the one place. Pure: string in, string out, no terminal, no policy.
 */

/** The glyph that opens a refusal row. Also what `isRefusalLine()` keys on. */
export const REFUSAL_MARK = '✖';

/** The verb right after the mark; with the mark it is the row's whole signature. */
export const REFUSAL_VERB = 'Refused';

/**
 * The row `formatRefusalLine()` writes, as a pattern: optional indent, the mark, the
 * verb, then whatever reason the refusing layer had. `classifyLine()` matches a row
 * with it before the `Error` rules, so a reason that happens to mention an error
 * cannot repaint a refusal as one.
 */
export const REFUSAL_LINE_RE = new RegExp(`^\\s*${REFUSAL_MARK}\\s*${REFUSAL_VERB}\\b`);

/**
 * One refusal, as the single line the reader gets.
 *
 * The model already receives the structured refusal in the call's own chunk
 * (`docs/agent/tool-multicall`); this line is the *human* half of the same news, so
 * it says which call was stopped, in which mode, and why — the reason the refusing
 * layer computed, never a generic phrase invented here.
 *
 * @param {{name?: string, reason?: string|null, mode?: string|null}} [call] the
 *   refused call; `reason` is `app/tool-guard.js`'s, `mode` names the session mode.
 */
export function formatRefusalLine({ name = 'unknown_tool', reason = null, mode = null } = {}) {
  const why = reason || 'the current mode does not allow this call';
  const where = mode ? ` (${mode})` : '';
  return `  ${REFUSAL_MARK} ${REFUSAL_VERB} ${name}${where}: ${why}`;
}

/** True when a display line is a refusal row (the palette's own test). */
export function isRefusalLine(line) {
  return REFUSAL_LINE_RE.test(String(line ?? ''));
}
