import { createBrandBar } from './brand-bar.js';
import { createNoticeBar } from './notice-bar.js';
import { createToastBar } from './tui-toast.js';

/**
 * The three things that float over the top of the screen, built together because their
 * order and their anchoring is a single decision: the brand line, the provider notices
 * and the copy toast.
 *
 * The stacking is the point, and it is why they are not three independent widgets:
 *
 *  - the **brand line** owns the very first row — "MONCHO (v x.y.z)" — and tells the
 *    layout how many rows it took (`reserve`), so the conversation is displaced down while
 *    the mark is shown and returns when a narrow window makes it hide;
 *  - the **notices** anchor *below* the mark (`anchor: () => brandBar.band`), so a retry or
 *    a failure can never cover it. They span the width and hold for minutes, because a
 *    reader who looked away must still find them (`app/notice-overlay.js`);
 *  - the **toast** anchors there too, but is a small bordered box in the top-right corner
 *    that holds one plain sentence for four seconds (`app/toast.js`). It is deliberately
 *    not the notice overlay: a copy is something the reader just did on purpose, and it
 *    needs a flicker of proof rather than a row that must be found later.
 *
 * Extracted from `app/tui.js`, which wires the screen and is held to the project's line
 * budget; the region layout, the transcript and the input box each live in their own
 * module for the same reason. This one is small on purpose: it is the *seam* between the
 * three bars and the screen, not a fourth bar.
 *
 * `reserve` is the brand line's callback into the layout; `paint()` puts all three back
 * after a resize, which is also where the anchoring rows are re-read.
 */
export function createFloatingOverlays({
  screen = null,
  refresh = () => {},
  reserve = () => {},
  brandWidth = () => 0,
  brandHeight = () => 0,
} = {}) {
  // The brand mark is built first so the two overlays below can anchor under it.
  const brandBar = createBrandBar({
    screen,
    refresh,
    reserve,
    region: () => ({ width: brandWidth(), height: brandHeight() }),
  });

  const noticeBar = createNoticeBar({ screen, refresh, anchor: () => brandBar.band });
  const toastBar = createToastBar({ screen, refresh, anchor: () => brandBar.band });

  return {
    brandBar,
    noticeBar,
    toastBar,
    /** Re-fit all three; a resize is the only reason their rows move. */
    paint() {
      brandBar.paint();
      noticeBar.paint();
      toastBar.paint();
    },
    /** The reverse of construction, brand last so nothing anchors to a dead bar. */
    close() {
      noticeBar.close();
      toastBar.close();
      brandBar.close();
    },
  };
}