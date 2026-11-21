import { slashQuery, rankCommands, slashRows, SLASH_MAX_ROWS } from './slash-complete.js';

/**
 * The slash-command popup as a **state machine**: which commands answer what is in
 * the box, which row carries the cursor, and what accepting it does.
 *
 * Pure in the sense the rest of the interface is: it holds a source function and an
 * index and answers questions. It does not draw (that is `app/slash-bar.js`) and it
 * does not read keys (that is `app/prompt-keys.js` for the arrows and Enter, and
 * `app/tui-keys.js` for Tab and Escape, which are claimed before blessed dispatches
 * them).
 *
 * The source is a **function**, not a list, because the registry is built after the
 * screen (`main.js` builds the commands once the host loop is wired): the popup reads
 * it live on every keystroke, so it can never show commands that no longer exist nor
 * miss one registered later.
 *
 * Two ways to accept a row, deliberately different:
 *
 *  - **Tab** completes the name into the box and adds a space, so arguments can be
 *    typed next (`/sessions `). Nothing runs: completion is a sentence half-written.
 *  - **Enter** takes the row and submits it, because pressing Enter on a highlighted
 *    menu entry means "do that one" — the box is set to the name first, so what the
 *    loop answers is exactly the command that was on screen.
 */

/** The text Tab puts in the box for a command: the name, a space, ready for arguments. */
export function slashCompleteText(command) {
  const name = String(command?.name || '');
  return name ? `/${name} ` : '';
}

/** The text Enter submits for a command: the name alone. */
export function slashAcceptText(command) {
  const name = String(command?.name || '');
  return name ? `/${name}` : '';
}

/**
 * @param {object} options
 * @param {Function|object[]} [options.source] a function returning the commands
 *   (`() => registry.list()`), or a plain list for a fixed popup
 * @param {number} [options.maxRows] how many rows fit at once
 */
export function createSlashMenu({ source = () => [], maxRows = SLASH_MAX_ROWS } = {}) {
  const read = typeof source === 'function' ? source : () => source;
  let open = false;
  let query = '';
  let ranked = [];
  let index = 0;

  /** The commands the registry holds right now; a throwing source is not a crash. */
  const commands = () => {
    try {
      const list = read();
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };

  /**
   * Follow the box: the popup opens on a half-typed `/name`, filters as the query
   * grows, and hides the moment the text is not a command name any more (a space
   * ends it) or nothing matches — an empty menu would only hide the box behind a
   * frame with nothing in it.
   *
   * The cursor resets to the best row when the **query** changed, and is kept when
   * only the list was re-read (a repaint), so a reader watching a session replay
   * does not lose their place.
   *
   * @param {string} text the box's value, verbatim
   * @returns {boolean} whether the popup is open afterwards
   */
  const sync = (text) => {
    const parsed = slashQuery(text);
    if (!parsed) {
      open = false;
      query = '';
      ranked = [];
      index = 0;
      return false;
    }

    const changed = parsed.query !== query;
    query = parsed.query;
    ranked = rankCommands(commands(), query);
    if (changed) index = 0;
    index = Math.max(0, Math.min(ranked.length - 1, index));
    open = ranked.length > 0;
    return open;
  };

  return {
    sync,
    /** The popup is up and there is at least one row to choose. */
    get isOpen() {
      return open;
    },
    /** The text after the slash that the rows answer ('' for a bare `/`). */
    get query() {
      return query;
    },
    /** The ranked matches, best first (all of them, not just the visible page). */
    get matches() {
      return ranked.slice();
    },
    /** The cursor, as an index in `matches`. */
    get index() {
      return index;
    },
    /** The row carrying the cursor, or null when the popup is closed. */
    current() {
      return open ? ranked[index] || null : null;
    },
    /**
     * Move the cursor by `delta`, wrapping around both ends like the picker
     * (`app/picker.js#createPicker.move`), so holding down an arrow walks the ring
     * instead of sticking at the last row.
     */
    move(delta = 1) {
      if (!open || ranked.length === 0) return null;
      const step = Math.trunc(Number(delta)) || 0;
      index = ((index + step) % ranked.length + ranked.length) % ranked.length;
      return this.current();
    },
    /** The text Tab completes into the box, or '' when there is nothing to complete. */
    completeText() {
      return slashCompleteText(this.current());
    },
    /** The text Enter submits, or '' when there is nothing to accept. */
    acceptText() {
      return slashAcceptText(this.current());
    },
    /** The rows to paint, fitted to `columns` display cells. */
    rows({ columns = 0 } = {}) {
      if (!open) return [];
      return slashRows(ranked, { index, columns, maxRows });
    },
    hide() {
      open = false;
      query = '';
      ranked = [];
      index = 0;
      return false;
    },
  };
}

export { slashQuery, rankCommands, slashRows, SLASH_MAX_ROWS };