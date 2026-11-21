import blessed from 'neo-blessed';

import {
  BRAND_COLOR,
  BRAND_RIGHT,
  BRAND_TOP,
  formatBrand,
  resolveBrandSize,
} from './brand.js';
import { activeTokens } from './theme.js';

/**
 * Bind the brand line (`app/brand.js`) to the **very first row of the screen**,
 * right-aligned.
 *
 * There is no image here — a cell carries one colour and no alpha, so the artwork
 * could never be composited (see `app/brand.js`) — which leaves this module only the
 * two things the pure formatter cannot have: the **row** and the **screen**.
 *
 *  - **the row belongs to the mark.** A borderless, one-row `blessed.box` at
 *    `top: BRAND_TOP` (row 0) and `right: BRAND_RIGHT`, and it reports its own height
 *    through `reserve`: `app/tui-layout.js#setBrandRows` moves the conversation down
 *    by that many rows, so the mark is a line *above* the conversation rather than
 *    something floating over it. The reader's scroll position is untouched.
 *  - **the row is given back.** Closing the bar — or a region too narrow to hold the
 *    line — reserves 0 rows, so the conversation returns to the top edge.
 *  - **the colour is a style, not a tag.** The line is written to the box's content
 *    *without* an inline `{colour-fg}` tag and painted through `style.fg`, because
 *    neo-blessed counts a tag's bytes towards the cell width and would clip the end
 *    of the line (see `app/brand.js#BRAND_COLOR`).
 *  - **it is a view of the fit rule.** Every paint asks `resolveBrandSize()` whether
 *    the region can hold the line, so "it fits or it is hidden" is enforced in one
 *    place, and a narrow window gets its row back instead of a clipped mark.
 *
 * Pure in the model sense: with no widget the whole thing still works (it just paints
 * nothing), which is how the line CLI and the unit tests drive it.
 */
export function createBrandBar({
  screen = null,
  line = formatBrand(),
  color = BRAND_COLOR,
  refresh = () => {},
  region = null,
  reserve = null,
  top = BRAND_TOP,
  right = BRAND_RIGHT,
} = {}) {
  let closed = false;
  let size = null;
  let painted = 0;
  let band = 0;
  const text = String(line ?? '');
  // The colour is read **live** (`docs/interface/skins`): a skin that moves the `brand`
  // token repaints the mark without rebuilding the bar. A `color` other than the shipped
  // default is the caller's explicit override and wins over the token.
  const explicitColor = color !== BRAND_COLOR;
  const liveColor = () => (explicitColor ? color : activeTokens().brand);

  const widget = screen
    ? blessed.box({
      parent: screen,
      top,
      right,
      width: 1,
      height: 1,
      tags: false,
      hidden: true,
      style: { fg: explicitColor ? color : activeTokens().brand },
      padding: { left: 0, right: 0 },
    })
    : null;

  /**
   * The room the bar may use. The line sits on the screen's top row, so the room is
   * the screen's width — not the conversation's — and the `right` offset is taken off
   * *here*, in the same place that decides the placement, so the fit rule and the
   * widget can never disagree about whether the last columns are spare.
   */
  function roomFor() {
    const room = (typeof region === 'function' ? region() : null) || {};
    const width = Number(room.width ?? screen?.width) || 0;
    const height = Number(room.height ?? screen?.height) || 0;
    return { width: Math.max(0, width - right), height };
  }

  /**
   * Repaint from the current window: the fit rule decides whether the line is shown,
   * the layout is told how many rows to displace the conversation by, and the widget
   * is hidden the moment there is nothing to show. Returns the size, or null.
   */
  const paint = () => {
    if (closed) return null;

    const room = roomFor();
    size = resolveBrandSize({
      width: room.width,
      height: room.height,
      line: text,
    });
    painted = size ? 1 : 0;

    // The mark owns the row it is on: tell the layout first, so the conversation is
    // displaced below the brand line rather than sharing row 0 with it.
    band = size ? size.rows : 0;
    if (typeof reserve === 'function') reserve(band);

    if (widget) {
      if (!size) {
        widget.hidden = true;
        widget.setContent('');
      } else {
        widget.setContent(text);
        widget.width = size.cols;
        widget.height = size.rows;
        widget.hidden = false;
        if (widget.style) widget.style.fg = liveColor();
      }
    }
    refresh();
    return size;
  };

  paint();

  return {
    widget,
    paint,
    /** The line as it is painted, so callers never re-derive it. */
    line: text,
    /** The colour it is painted in, read from the live token. */
    get color() {
      return liveColor();
    },
    /** The fit rule's answer for the last paint, or null when it was hidden. */
    get size() {
      return size;
    },
    /** Rows the conversation is displaced by, at the top, for the mark. */
    get band() {
      return band;
    },
    /** Rows painted right now, as a count (0 while hidden). */
    get visible() {
      return painted;
    },
    close() {
      if (closed) return;
      closed = true;
      size = null;
      painted = 0;
      band = 0;
      if (typeof reserve === 'function') reserve(0);
      if (widget && typeof widget.destroy === 'function') widget.destroy();
    },
  };
}