import { displayWidth, clustersWithin } from './cell-width.js';

/**
 * The **layout** of the `/skins prompt` modal (`docs/interface/skins`): how the box is
 * sized to the screen it is on, and how its body is refitted when that screen changes.
 *
 * The defect this module exists to fix: the modal was `width: '80%'`, `height: '60%'`
 * and its body was wrapped **by width only**. The body — the request, the preview of
 * every palette key and token, the name field and the hint — is taller than 60% of an
 * ordinary terminal, so blessed clipped the overflow and the **action list was pushed
 * off the bottom of the box**. A picker whose actions cannot be seen is a picker that
 * cannot be used, however well the arrow keys behave.
 *
 * Three rules fix it, and all three are about the *screen* rather than about the content:
 *
 *  - **the box is sized to the terminal, not to a percentage of it.** A percentage is
 *    resolved against the screen when the box is created, so a modal opened on a tall
 *    terminal keeps a tall box after the terminal is shrunk — and a modal opened on a
 *    short one is too short from the start. The size is computed from the live screen,
 *    so the box always holds what it must.
 *  - **the actions are reserved first.** The rows that answer the modal (apply, save,
 *    cancel) and the hint that explains them are what the user has to be able to read;
 *    the preview is context. So the room is given to the actions, and whatever is left
 *    goes to the body — and a body that does not fit is cut from the **top**, with a
 *    row that says how much was cut, so the user is told rather than left to wonder
 *    where the colours went.
 *  - **the box is never taller or wider than the terminal.** A box that overflows the
 *    screen is clipped by the screen, which is the very defect being fixed.
 *
 * Pure and terminal-free: it takes numbers and answers numbers, so every rule here is
 * unit tested without a screen.
 */

/** The smallest interior the modal is given, in rows and columns. */
export const MIN_MODAL_WIDTH = 24;
export const MIN_MODAL_HEIGHT = 6;

/** The fraction of the terminal the modal takes, before the minimums are applied. */
export const MODAL_WIDTH_FRACTION = 0.8;
export const MODAL_HEIGHT_FRACTION = 0.6;

/** The rows and columns the modal's border and padding take off its outer size. */
export const MODAL_CHROME_ROWS = 2;
export const MODAL_CHROME_COLUMNS = 4;

/**
 * A blessed colour tag: `{cyan-fg}` or `{/cyan-fg}`. Blessed's own parser accepts
 * `[\w\-,;!#]*` between the braces, so that is exactly what is recognised here.
 */
const BLESSED_TAG_RE = /\{\/?[\w\-,;!#]*\}/g;

/**
 * The size of the modal on a screen of `columns` × `rows`.
 *
 * The box may not be wider or taller than the terminal itself, and the minimums
 * apply after the fraction: a tiny terminal yields a small box rather than a
 * negative one.
 *
 * @param {object} options
 * @param {number} [options.columns] the terminal's width
 * @param {number} [options.rows] the terminal's height
 * @returns {{width: number, height: number}} the outer size of the box
 */
export function modalBoxSize({ columns = 0, rows = 0 } = {}) {
  const width = Math.trunc(Number(columns)) || 0;
  const height = Math.trunc(Number(rows)) || 0;
  if (width <= 0 || height <= 0) {
    return { width: MIN_MODAL_WIDTH, height: MIN_MODAL_HEIGHT };
  }
  const boxWidth = Math.min(width, Math.max(MIN_MODAL_WIDTH, Math.floor(width * MODAL_WIDTH_FRACTION)));
  const boxHeight = Math.min(height, Math.max(MIN_MODAL_HEIGHT, Math.floor(height * MODAL_HEIGHT_FRACTION)));
  return { width: boxWidth, height: boxHeight };
}

/**
 * The interior of a box of that outer size: the rows and columns the content has.
 *
 * @param {object} size the outer size, from `modalBoxSize()`
 * @returns {{rows: number, columns: number}} the interior
 */
export function modalInterior({ width = 0, height = 0 } = {}) {
  return {
    rows: Math.max(0, (Math.trunc(Number(height)) || 0) - MODAL_CHROME_ROWS),
    columns: Math.max(0, (Math.trunc(Number(width)) || 0) - MODAL_CHROME_COLUMNS),
  };
}

/**
 * The visible width of a row, with the blessed colour tags left out.
 *
 * A tag (`{cyan-fg}`) costs no cells on the screen — it is an escape, not a glyph —
 * so a row that carries tags is measured by its text alone.
 *
 * @param {string} text the row
 * @returns {number} the cells the row occupies
 */
export function visibleWidth(text) {
  return displayWidth(String(text ?? '').replace(BLESSED_TAG_RE, ''));
}

/**
 * Cut a row to the columns the box has, keeping its colour tags whole.
 *
 * The cut is made between grapheme clusters (`app/cell-width.js`), so a truncated
 * row never ends on half a glyph, and a tag that is still open when the cut falls is
 * **closed**: an unclosed tag would leave the colour open for the rest of the box.
 *
 * @param {string} text the row
 * @param {number} columns the columns the box has
 * @returns {string} the row, cut to fit
 */
export function fitRow(text, columns) {
  const limit = Math.max(0, Math.trunc(Number(columns)) || 0);
  const row = String(text ?? '');
  if (!limit) return '';
  if (visibleWidth(row) <= limit) return row;

  const parts = row.split(/(\{\/?[\w\-,;!#]*\})/g);
  const open = [];
  let out = '';
  let used = 0;
  let cut = false;

  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('{')) {
      const closing = part.startsWith('{/');
      const name = part.replace(/^\{\/?/, '').replace(/\}$/, '');
      if (closing) {
        const at = open.lastIndexOf(name);
        if (at >= 0) open.splice(at, 1);
      } else if (name) {
        open.push(name);
      } else {
        // `{/}` is the reset tag: it closes everything.
        open.length = 0;
      }
      out += part;
      continue;
    }
    const room = limit - used;
    if (room <= 0) {
      cut = true;
      break;
    }
    const width = displayWidth(part);
    if (width <= room) {
      out += part;
      used += width;
      continue;
    }
    out += `${clustersWithin(part, Math.max(0, room - 1)).join('')}…`;
    used = limit;
    cut = true;
    break;
  }

  if (cut) {
    for (const name of [...open].reverse()) out += `{/${name}}`;
  }
  return out;
}

/**
 * Fit the modal's rows into the rows the box has.
 *
 * The rows that matter are kept and the **preview** is what gets cut:
 *
 *  - the **request** is the first row of the body and is never cut: it is the question
 *    the modal is answering, and a modal that cannot say what it is about is a modal
 *    the user cannot answer.
 *  - the **name** row (the proposal's own name, or the editable field) is kept: it is
 *    what the skin will be called, and it is the one row the user has to *change*.
 *  - the **hint** — the last row of the body — is kept: it says what Enter will do, and
 *    a modal that does not say so makes the keyboard look broken.
 *  - the **actions** are never cut either: they are what the user has to be able to
 *    read to answer the modal.
 *  - the **preview** in between is context, so it is what goes — from the top, with a
 *    row that says how much went, so the user is told rather than left to wonder where
 *    the colours went.
 *
 * @param {object} options
 * @param {string[]} [options.body] the rows above the actions
 * @param {string[]} [options.actions] the rows that answer the modal
 * @param {number} [options.room] the rows the box holds
 * @param {string[]} [options.keep] the body rows that are never cut
 * @returns {string[]} the rows that fit, in order
 */
export function fitModalRows({ body = [], actions = [], room = 0, keep = [] } = {}) {
  const limit = Math.max(0, Math.trunc(Number(room)) || 0);
  const actionRows = Array.isArray(actions) ? actions : [];
  const bodyRows = Array.isArray(body) ? body : [];
  if (!limit) return [];

  // The rows that are never cut, in the order they matter: the request first (it is
  // the question the modal is answering), then the rows the modal names (the proposal
  // and the editable name), then the hint (it says what Enter will do).
  const priority = [];
  const add = (index) => {
    if (index >= 0 && index < bodyRows.length && !priority.includes(index)) priority.push(index);
  };
  add(0);
  for (const row of keep) add(bodyRows.indexOf(row));
  add(bodyRows.length - 1);

  // The actions come first into the budget: they are what the user has to be able to
  // read to answer the modal.
  const shownActions = actionRows.slice(0, limit);
  let roomLeft = limit - shownActions.length;

  // The rows that are never cut take what is left, in their order of importance.
  const shown = new Set();
  for (const index of priority) {
    if (roomLeft <= 0) break;
    shown.add(index);
    roomLeft -= 1;
  }

  // The preview fills what is left. It reads top to bottom, so the rows that survive
  // are the last ones — the ones nearest the name, about the skin itself — and a row
  // says how many went.
  const rest = bodyRows.map((row, index) => index).filter((index) => !shown.has(index));
  let marker = '';
  if (rest.length) {
    if (rest.length <= roomLeft) {
      for (const index of rest) shown.add(index);
      roomLeft -= rest.length;
    } else if (roomLeft > 0) {
      // One row is spent on the marker that says what was cut.
      const survivors = rest.slice(Math.max(0, rest.length - (roomLeft - 1)));
      for (const index of survivors) shown.add(index);
      const dropped = rest.length - survivors.length;
      marker = `… ${dropped} row${dropped === 1 ? '' : 's'} above`;
    }
  }

  // The body keeps its own order, so it still reads top to bottom.
  const keptBody = bodyRows.filter((row, index) => shown.has(index));
  if (marker) {
    // The marker sits where the cut was: at the top of the preview.
    const firstPreview = rest.find((index) => !shown.has(index));
    const at = firstPreview === undefined ? keptBody.length : keptBody.indexOf(bodyRows[firstPreview]);
    keptBody.splice(at < 0 ? 0 : at, 0, marker);
  }
  return [...keptBody, ...shownActions];
}
