import { isBandRole, isBlankBand } from './prose-band.js';

/**
 * Append a group of display lines to the transcript model, with the band margins.
 *
 * The transaction belongs together: whether a margin is owed depends on the entry
 * *before* the group, so deciding it line by line would double a margin wherever two
 * bands meet. This module owns that one decision, keeping `app/transcript-view.js` the
 * widget binding and `app/transcript.js` the plain model.
 *
 * Three rules, all of them the band's (`docs/interface/prose-bands`):
 *
 *  - a **banded** group opens and closes with one blank banded row — the band's own
 *    role, so the margin reads as part of the block and not as a gap;
 *  - two bands that **meet** share one blank row: the margin is added only when the
 *    previous entry is not already a blank banded row;
 *  - the **stamp** goes on the first line that is not blank, so an entry that opens
 *    with a blank line is marked where its text really starts (`app/transcript-stamp.js`).
 *
 * Pure in the sense that matters: it takes the model and a `mark()` clock and returns
 * nothing, so the rules are unit tested without a terminal.
 */
export function appendLines(model, lines = [], { role = null, mark = () => null } = {}) {
  if (!model) return 0;
  const list = Array.isArray(lines) ? lines : [lines];
  const band = isBandRole(role);
  const last = model.entries[model.entries.length - 1] || null;

  if (band && !isBlankBand(last)) model.addLine('', { role });

  const first = list.findIndex((line) => String(line).trim() !== '');
  list.forEach((line, index) => {
    model.addLine(line, { stamp: index === first ? mark() : null, role });
  });
  if (band) model.addLine('', { role });

  return list.length;
}
