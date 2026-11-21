/**
 * Collapsing a large paste into a tag, and restoring it exactly
 * (`docs/interface/tui`).
 *
 * Extracted from `app/tui-render.js`, which was at its line budget: this is a small,
 * self-contained pair of inverses — the input box collapses a long block so the caret can
 * still be moved, and the host expands the tags again before the prompt reaches the model.
 *
 * Pure and terminal-free, so the round trip is unit tested without a screen. The original
 * bytes are kept **verbatim** in the `pastes` array, so expanding returns exactly what was
 * collapsed, newlines and trailing whitespace included.
 */

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