import { clustersWithin, displayWidth, graphemes, graphemeWidth } from './cell-width.js';

/**
 * Copying to the terminal's clipboard, which is the only clipboard a TUI can reach.
 *
 * A process cannot open the system clipboard without a native module, and a mouse
 * selection made by the *terminal itself* is not visible to us at all — the terminal
 * paints it and keeps it. So the conversation does the selection in its own model
 * (`app/transcript-select.js`) and hands the text back to the terminal with **OSC 52**,
 * the escape sequence a terminal answers by putting the payload on the clipboard of the
 * machine the user is sitting at.
 *
 * Three properties matter, and each is a rule below:
 *
 *  - **the sequence is bounded.** A terminal truncates or drops an oversized OSC 52, so
 *    a copy that is silently cut in half is worse than one that says it was cut: the text
 *    is trimmed to `CLIPBOARD_MAX_BYTES` of *encoded* payload, always between grapheme
 *    clusters, and the report says `truncated: true` so the caller can tell the user.
 *  - **multiplexers need wrapping.** tmux and GNU screen swallow a bare OSC 52 unless it
 *    is passed through in their own escape envelope, so the writer asks the environment
 *    which one it is inside and wraps accordingly.
 *  - **encoding never throws.** The payload is base64 of UTF-8 (`Buffer`), so an emoji
 *    survives the trip as itself; an empty text is not a copy at all and answers null
 *    rather than emitting a sequence that would clear the user's clipboard.
 *
 * Pure: the sequence is built as a string and the caller decides where to write it.
 */

/**
 * The most base64 the sequence may carry. Terminals differ and the smallest common
 * ceiling is around 100 KB; past that xterm and friends silently drop the payload, which
 * looks exactly like a copy that never happened. Cutting at the ceiling keeps the copy
 * working and the report honest.
 */
export const CLIPBOARD_MAX_BYTES = 100 * 1024;

/** The OSC 52 terminator: BEL. ST (`\x1b\\`) is equally valid and less portable. */
export const OSC_TERMINATOR = '\x07';

/** The clipboard a bare OSC 52 targets: `c` is the system clipboard, `p` the primary. */
export const CLIPBOARD_SELECTION = 'c';

/** Which multiplexer we are inside, from the environment, or null. */
export function multiplexerOf(env = {}) {
  if (env.TMUX) return 'tmux';
  if (env.STY) return 'screen';
  return null;
}

/**
 * Cut `text` so its base64 fits `maxBytes`, never inside a character.
 *
 * The budget is on the *encoded* size because that is what the terminal counts: three
 * bytes of text cost four of base64. The cut is made between grapheme clusters, so an
 * emoji is copied whole or not at all, and the `…` that marks the cut is charged to the
 * budget like any other cluster.
 */
export function fitToClipboard(text, maxBytes = CLIPBOARD_MAX_BYTES) {
  const source = String(text ?? '');
  const limit = Math.max(4, Math.trunc(Number(maxBytes)) || CLIPBOARD_MAX_BYTES);
  if (!source) return { text: '', truncated: false, bytes: 0 };

  const encoded = Buffer.from(source, 'utf8').toString('base64');
  if (encoded.length <= limit) return { text: source, truncated: false, bytes: encoded.length };

  // Each cluster costs at most 4 bytes of text and therefore 8 of base64 (a 4-byte
  // astral cluster), so this budget is generous enough that the trim below never runs
  // out of room for the ellipsis it appends.
  const room = Math.max(0, Math.floor(limit / 4) - 1);
  const kept = clustersWithin(source, room);
  while (kept.length > 0
    && Buffer.from(`${kept.join('')}…`, 'utf8').toString('base64').length > limit) {
    kept.pop();
  }
  const trimmed = kept.length > 0 ? `${kept.join('')}…` : '';
  return {
    text: trimmed,
    truncated: true,
    bytes: Buffer.from(trimmed, 'utf8').toString('base64').length,
  };
}

/**
 * The escape sequence that puts `text` on the clipboard, or null when there is nothing
 * to copy.
 *
 * The result is what the caller writes verbatim to the terminal: OSC 52, the selection,
 * the base64 payload, and BEL — wrapped in the multiplexer's passthrough envelope when
 * the environment says we are inside one.
 */
export function osc52(text, { env = process.env, maxBytes = CLIPBOARD_MAX_BYTES } = {}) {
  const fitted = fitToClipboard(text, maxBytes);
  if (!fitted.text) return null;

  const payload = Buffer.from(fitted.text, 'utf8').toString('base64');
  const inner = `\x1b]52;${CLIPBOARD_SELECTION};${payload}${OSC_TERMINATOR}`;
  const multiplexer = multiplexerOf(env);
  // tmux needs the escape doubled inside its own DCS passthrough; screen needs a bare
  // DCS. A terminal that is neither takes the sequence as it is.
  if (multiplexer === 'tmux') return `\x1bPtmux;\x1b${inner}\x1b\\`;
  if (multiplexer === 'screen') return `\x1bP${inner}\x1b\\`;
  return inner;
}

/**
 * The copy writer the TUI holds: one place that knows how a sequence reaches the screen
 * and what to report about it.
 *
 * `write` is injected — the TUI passes blessed's program, a test a collector — so the
 * whole path is exercised without a terminal. A missing or throwing `write` is reported
 * as `ok: false` rather than propagated: a copy is a convenience, and losing the
 * clipboard must never take the conversation down with it.
 *
 * The **native tool is tried first** and the escape sequence is the fallback, because the
 * two are not equally trustworthy: a native tool that exits 0 has really put the text on
 * the clipboard, while OSC 52 is honoured only when the terminal chooses to and is dropped
 * in silence when it does not (see `app/clipboard-native.js`). The report says which path
 * delivered the text, so a caller can say *how* it landed rather than only that it did.
 */
export function createClipboard({
  write = null, env = process.env, maxBytes = CLIPBOARD_MAX_BYTES, native = null,
} = {}) {
  return {
    /**
     * Copy `text`, and report exactly what happened:
     * `{ ok, bytes, truncated, chars, via, error }`.
     *
     * `via` is the path that delivered it (`'pbcopy'`, `'xclip'`, `'osc52'`) or null when
     * nothing did.
     */
    copy(text) {
      const fitted = fitToClipboard(text, maxBytes);
      const report = {
        ok: false,
        bytes: fitted.bytes,
        truncated: fitted.truncated,
        chars: graphemes(fitted.text).length,
        via: null,
        error: null,
      };
      if (!fitted.text) return { ...report, error: 'EMPTY' };

      // The native tool first: it either works or says why not, and either answer is worth
      // more than a sequence the terminal may quietly ignore.
      if (native && typeof native.write === 'function') {
        const attempt = native.write(fitted.text);
        if (attempt?.ok) return { ...report, ok: true, via: attempt.via ?? 'native' };
        if (attempt?.error === 'EMPTY') return { ...report, error: 'EMPTY' };
      }

      if (typeof write !== 'function') return { ...report, error: 'NO_WRITER' };
      const sequence = osc52(fitted.text, { env, maxBytes });
      if (!sequence) return { ...report, error: 'EMPTY' };
      try {
        write(sequence);
      } catch (error) {
        return { ...report, error: error?.message || 'WRITE_FAILED' };
      }
      return { ...report, ok: true, via: 'osc52' };
    },
    /** What the sequence would be for `text`, without writing it. */
    sequence: (text) => osc52(text, { env, maxBytes }),
  };
}

export { displayWidth, graphemeWidth };
