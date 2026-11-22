import { SPINNER_FRAMES } from './status-row.js';
import { formatDuration } from '../utils/working-time.js';
import { PALETTE_KEYS, PRESENTATION_KEYS } from '../utils/skins-store.js';

/**
 * The **text** half of the `/skins prompt` modal (`docs/interface/skins`): what the
 * confirmation box paints, with no blessed and no screen.
 *
 * Split out of `app/skin-modal.js` so the two responsibilities stay apart — this module
 * decides *what the body says*, the modal decides *when it is painted and who owns the
 * keyboard* — and so the wording is unit testable without a terminal, the same way
 * `app/tui-render.js` carries the composition the widgets call.
 *
 * The waiting state is **live** on purpose. A model call takes seconds, and a body
 * painted once reads as a hang: `formatSkinWaiting()` carries a spinner frame and the
 * elapsed time, and the modal advances both on a timer. The indicator is
 * *indeterminate* — how long a model will take is not knowable, so a percentage or a
 * determinate bar would be a lie about it.
 */

/**
 * Wrap `label: key:value  key:value …` on the `  ` boundaries, so a row breaks between
 * two colours instead of in the middle of one (`noti` / `ce:grey` reads as a typo).
 * A single token wider than the room is left whole rather than cut, because a colour
 * name is a unit.
 */
function wrapEntries(label, entries, width) {
  const rows = [];
  let line = label;
  for (const entry of entries) {
    const candidate = `${line}  ${entry}`;
    if (width && line.trim() && candidate.length > width) {
      rows.push(line);
      line = entry;
    } else {
      line = candidate;
    }
  }
  rows.push(line);
  return rows;
}

/**
 * The row that names the proposed skin: `skin: <name>`.
 *
 * It is the one row of the preview that says **what** is being proposed, so it is
 * written here rather than inline in the preview: the modal needs the same row to
 * keep it on screen when the box is too small for the whole preview
 * (`app/skin-modal-layout.js`), and the two must not drift apart.
 *
 * @param {object} skin the proposed skin
 * @returns {string} the row
 */
export function formatSkinName(skin) {
  return `skin: ${skin?.name ?? '?'}`;
}

/** The palette/token preview lines of a proposed skin, so the modal shows the look. */
export function formatSkinPreview(skin, { width = 0 } = {}) {
  const palette = PALETTE_KEYS.map((key) => `${key}:${skin?.palette?.[key] ?? '?'}`);
  const tokens = PRESENTATION_KEYS.map((key) => `${key}:${skin?.[key] ?? '?'}`);
  return [
    formatSkinName(skin),
    ...wrapEntries('palette ', palette, width),
    ...wrapEntries('tokens  ', tokens, width),
  ];
}

/**
 * The waiting line: a moving frame and the elapsed time, so a call that takes
 * seconds is visibly *in progress* rather than a still image.
 *
 * The frame is picked from `SPINNER_FRAMES` — the same braille the status bar spins
 * (`app/status-row.js`) — so the two indicators read as the same kind of thing.
 */
export function formatSkinWaiting({ frame = 0, elapsedMs = 0 } = {}) {
  const glyph = SPINNER_FRAMES[Math.abs(Math.floor(Number(frame) || 0)) % SPINNER_FRAMES.length];
  return `asking the model for a skin… ${glyph} ${formatDuration(elapsedMs)}`;
}

/**
 * The hint under the actions, saying what Enter will do.
 *
 * The hint is honest about the focus: in the name field Enter moves to the actions (the
 * name is meant to be read before anything is applied), and in the actions Enter applies.
 * While the proposal is still coming there is nothing to apply, so the hint says so
 * instead of leaving the user to guess why only Cancel is offered.
 */
export function formatSkinHint({
  state = 'waiting', nameError = '', focus = 'name', editable = true,
} = {}) {
  if (state === 'waiting') return 'the skin is still being prepared — Enter cancels';
  if (state === 'error') return 'nothing came back — Enter cancels';
  if (nameError) return nameError;
  // No name field: the name is already settled, so there is nothing to type and Enter applies.
  if (!editable) return 'Enter applies · Esc cancels';
  if (focus === 'actions') return 'Enter applies · Tab back to the name';
  return 'type to rename · Enter to the actions · Esc cancels';
}

/**
 * One painted body: the request, a live waiting line, or the proposal.
 *
 * The proposal carries the **editable name field** (`nameRow`, with the caret when it has
 * the focus) and a hint naming what Enter does. The actions are painted by the modal, not
 * here: they are gated on the proposal being ready (`app/skin-actions.js`), which is a
 * decision this module deliberately does not make.
 */
export function formatSkinBody({
  request = '', state = 'waiting', skin = null, width = 0, error = '', frame = 0, elapsedMs = 0,
  nameRow = '', nameError = '', hint = '',
} = {}) {
  const head = [`request: ${request}`];
  if (state === 'waiting') {
    const why = hint || formatSkinHint({ state });
    return [...head, '', formatSkinWaiting({ frame, elapsedMs }), '', why];
  }
  if (state === 'error' || !skin) {
    const why = hint || formatSkinHint({ state });
    return [...head, '', `no skin came back${error ? `: ${error}` : ''}`, '', why];
  }
  const rows = [...head, '', ...formatSkinPreview(skin, { width })];
  if (nameRow) rows.push('', nameRow);
  const why = nameError || hint;
  if (why) rows.push(why);
  return rows;
}
