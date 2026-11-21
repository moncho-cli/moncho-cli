import blessed from 'neo-blessed';
import { SLASH_COLORS, activeTokens } from './theme.js';

/**
 * The slash-command popup as a blessed region: a bordered box that sits **directly on
 * top of the input box** and grows upward with its rows (task-backlog: "show a popup
 * there right on top with the matching commands").
 *
 * Three decisions, each for a reason the other floating bars do not share:
 *
 *  - **anchored above the box, not at a corner.** The popup belongs to what is being
 *    typed, so it reads as part of the input — a corner box would be a second thing on
 *    screen rather than a continuation of the line. It is positioned from the bottom
 *    (`bottom` and a height), because that is the edge it must never move away from.
 *  - **`top` is re-read on every paint.** The queue bar sits between the input box and
 *    the conversation and changes height as messages are queued and drained
 *    (`app/tui-layout.js#setQueueHeight`), so a captured bottom would put the popup
 *    over a queued message. It is asked for on every paint instead.
 *  - **hidden with no rows**, so a closed popup costs no cells and paints no frame. It
 *    covers the conversation while it is up, which is deliberate: it is transient and
 *    follows one keystroke, exactly like the completion it offers.
 *
 * The selected row is painted as a **solid band** — a blue background filled to the
 * region's full width, with white foreground — rather than as reverse video. Two reasons,
 * and the first was a bug: the box used to be built with `tags: false`, so the
 * `{inverse}…{/inverse}` markers were painted as literal text in the middle of the row.
 * A background fill is also the thing a reader actually asked for, and it reads as a
 * selection even on a terminal whose inverse happens to match the border colour. The
 * fill is measured in cells from the width the rows were fitted to, so it reaches the
 * box's right padding instead of stopping short of it.
 *
 * Pure in the model sense, like the rest of these bars: with no screen the whole thing
 * still works (it just paints nothing), which is how the line CLI and the unit tests
 * drive it.
 *
 * The band and the box border are read **live** (`docs/interface/skins`): a skin that
 * moves `SLASH_COLORS`/the border token repaints the open popup instead of leaving it
 * at the colours of import time, which is why the two markers are functions and never
 * snapshot constants.
 */

/** The open of the selected row's band, from the palette in force right now. */
export function selectedOpen() {
  return `{${SLASH_COLORS.selected}-bg}{${SLASH_COLORS.selectedFg}-fg}`;
}

/** The close of the selected row's band, from the palette in force right now. */
export function selectedClose() {
  return `{/${SLASH_COLORS.selectedFg}-fg}{/${SLASH_COLORS.selected}-bg}`;
}

/** Cells a row uses before its text: the region's border and padding on both sides. */
function chromeOf(widget) {
  const chrome = Number(widget?.iwidth);
  return Number.isFinite(chrome) && chrome > 0 ? Math.trunc(chrome) : 0;
}

export function createSlashBar({
  screen = null,
  menu = null,
  refresh = () => {},
  anchor = null,
  columns = null,
} = {}) {
  let closed = false;
  let painted = [];
  // Declared before `roomFor()` so an early call reads `undefined` instead of throwing on
  // a `const` in its temporal dead zone. Every paint happens long after the widget exists.
  let widget = null;

  /** The row of the box top the popup's last row hangs above. */
  const anchorBottom = () => {
    const value = typeof anchor === 'function' ? anchor() : 0;
    return Math.max(0, Math.trunc(Number(value)) || 0);
  };

  /**
   * The interior width the rows are fitted to, in cells.
   *
   * The caller's accessor is the answer when it has one: the TUI passes the screen's own
   * width less the region's chrome, because both sides of the box (its border and its
   * padding) cost cells on every row. Without an accessor the widget's own layout box
   * answers, chrome subtracted. Getting this one cell wrong is what makes a row wrap onto
   * a display line the region's height does not have (the bug the queue preview had,
   * `docs/interface/message-queue`) or leaves a band that stops short of the padding.
   */
  const roomFor = () => {
    const asked = typeof columns === 'function' ? Math.trunc(Number(columns())) || 0 : 0;
    if (asked > 0) return asked;
    const width = Math.trunc(Number(widget?.width) || Number(screen?.width) || 0);
    return Math.max(0, width - chromeOf(widget));
  };

  // One row of border above and below, so the box is two rows taller than its rows.
  const boxHeight = (rowCount) => (rowCount > 0 ? rowCount + 2 : 0);

  widget = screen
    ? blessed.box({
      parent: screen,
      left: 0,
      right: 0,
      bottom: anchorBottom(),
      height: 0,
      border: { type: 'line' },
      // Tags on, because the selected row is a **painted band**: without this the marker
      // is printed literally, which is the bug this was fixed for.
      tags: true,
      hidden: true,
      padding: { left: 1, right: 1 },
      style: { border: { fg: 'cyan' } },
    })
    : null;

  /** One row's content: the plain text, or the same text filled out with a blue band. */
  const paintRow = (row, room) => {
    if (!row.selected) return row.text;
    const fill = Math.max(0, room - row.text.length);
    return `${selectedOpen()}${row.text}${' '.repeat(fill)}${selectedClose()}`;
  };

  /**
   * Repaint from the model: the rows become the widget's content, the box grows to
   * exactly hold them and is hidden when there are none.
   */
  const paint = () => {
    if (closed) return [];
    const room = roomFor();
    painted = menu && typeof menu.rows === 'function' ? menu.rows({ columns: room }) : [];
    if (widget) {
      const lines = painted.map((row) => paintRow(row, room));
      widget.setContent(lines.join('\n'));
      widget.height = boxHeight(painted.length);
      widget.bottom = anchorBottom();
      widget.hidden = painted.length === 0;
      // The border is a live token too: a skin that moved it repaints here.
      if (widget.style?.border) widget.style.border.fg = activeTokens().border;
    }
    refresh();
    return painted;
  };

  return {
    widget,
    paint,
    /** The rows painted right now, best first (empty while closed). */
    rows: () => painted.slice(),
    /** How many rows the box holds, borders excluded. */
    get height() {
      return painted.length;
    },
    get visible() {
      return painted.length > 0;
    },
    /** The interior width the rows are fitted to, in cells (0 when unknown). */
    get columns() {
      return roomFor();
    },
    close() {
      if (closed) return;
      closed = true;
      painted = [];
      if (widget && typeof widget.destroy === 'function') widget.destroy();
    },
  };
}

export { SLASH_MAX_ROWS } from './slash-complete.js';