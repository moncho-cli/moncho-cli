import {
  FOLLOW_BOTTOM_PERCENT,
  WHEEL_STEP_ROWS,
  pageStepRows,
  isFollowingScroll,
} from './transcript-scroll.js';
import {
  scrollOffset as scrollOffsetOf,
  scrollHeight as scrollHeightOf,
  visibleHeight as visibleHeightOf,
} from './transcript-geometry.js';

// The scroll rule and the gesture steps live in ./transcript-scroll.js, which is pure.
// They are re-exported here because this is the module that uses them, so an importer
// reading the viewport gets the whole vocabulary in one place.
export { FOLLOW_BOTTOM_PERCENT, WHEEL_STEP_ROWS, pageStepRows, isFollowingScroll };

/**
 * Where the view *is*: the follow/hold decision, the scroll operations and the wheel.
 *
 * Extracted from `app/transcript-view.js`, which owns the model and the painting and was
 * carrying both: "what the conversation says" and "which part of it is on screen" are two
 * responsibilities, and only the second one is about geometry. The view asks this module
 * for a decision (`apply`) and for a move (`scrollRows`, `scrollPage`); the module never
 * looks at the model.
 *
 * The offset is the source of truth, never blessed's internal `_userScrolled` latch: the
 * widget reaches the end by several routes (End, the mouse, a resize) and the latch cannot
 * be trusted to track them all. Before the first layout there is no geometry, and
 * following is the safe answer — nothing has been scrolled away yet.
 *
 * `repaint` is called when a scroll actually moved, so a gesture that hit the end of the
 * content costs no repaint.
 */
export function createViewport({ widget = null, repaint = () => {} } = {}) {
  /** Is the transcript parked at the bottom right now? (see isFollowingScroll) */
  const following = () => {
    if (!widget || !widget.lpos) return true;
    return isFollowingScroll({
      percent: typeof widget.getScrollPerc === 'function' ? widget.getScrollPerc() : 0,
      scrollHeight: scrollHeightOf(widget),
      visibleHeight: visibleHeightOf(widget),
    });
  };

  /**
   * Take the repaint's decision **now**, and return the closure that puts the view there.
   *
   * The split is the point. The rule asks "is the reader at the bottom?", and a widget that
   * has just been handed more lines is no longer at the same bottom — so deciding after the
   * content changed reads the append as "the reader scrolled up" and freezes a view that was
   * following. The caller therefore calls `decide()` **before** it hands the widget its new
   * content, and applies the returned closure after.
   *
   * `keepScroll: true` holds the offset the reader chose; `false` follows the newest line;
   * left undefined, the follow rule above decides. This is the only place that writes the
   * offset, so no other code path can move the view by accident.
   */
  const decide = ({ keepScroll } = {}) => {
    if (!widget) return () => null;
    const hold = keepScroll === undefined ? !following() : Boolean(keepScroll);
    const offset = scrollOffsetOf(widget);
    return () => {
      if (hold) widget.setScroll(offset);
      else widget.setScrollPerc(100);
      return hold;
    };
  };

  /** Decide and apply in one step, for a caller that changes nothing in between. */
  const apply = (options) => decide(options)();
  /**
   * Move the view by `delta` rows (positive = towards the bottom), clamped to the content.
   * Returns true when the view actually moved.
   *
   * A scroll is **not** a repaint of the content: blessed only has to move the viewport
   * instead of re-parsing every line. Rebuilding the content on every step is what makes a
   * wheel notch feel like a stutter, so this path never calls `setContent()`.
   */
  const scrollRows = (delta) => {
    if (!widget || typeof widget.scroll !== 'function') return false;
    const step = Math.trunc(Number(delta) || 0);
    if (step === 0) return false;
    const before = Number(widget.childBase) || 0;
    // blessed clamps at both ends itself, so the view can never be scrolled past the
    // first or the last row.
    widget.scroll(step);
    const moved = (Number(widget.childBase) || 0) !== before;
    if (moved) repaint();
    return moved;
  };

  /**
   * Move a whole screenful: `direction > 0` pages towards the bottom.
   *
   * The step is `pageStepRows()`, one row short of the screenful, so the last row of the
   * previous page is the first row of the next one and a reader paging through a long
   * result never skips a line.
   */
  const scrollPage = (direction = 1) => {
    const sign = Number(direction) < 0 ? -1 : 1;
    return scrollRows(sign * pageStepRows(visibleHeightOf(widget)));
  };

  // The mouse wheel nudges the view a few rows per notch. The handlers are ours rather
  // than blessed's `mouse: true` ones: that option also installs a half-screen wheel step
  // and scrollbar dragging, and this widget's click is already taken by the block toggle
  // and the mouse selection.
  const wheelUp = () => { scrollRows(-WHEEL_STEP_ROWS); };
  const wheelDown = () => { scrollRows(WHEEL_STEP_ROWS); };

  const canListen = typeof widget?.on === 'function' && typeof widget?.removeListener === 'function';
  if (canListen) {
    widget.on('wheelup', wheelUp);
    widget.on('wheeldown', wheelDown);
  }

  return {
    following,
    decide,
    apply,
    scrollRows,
    scrollPage,
    close() {
      if (!canListen) return;
      widget.removeListener('wheelup', wheelUp);
      widget.removeListener('wheeldown', wheelDown);
    },
  };
}
