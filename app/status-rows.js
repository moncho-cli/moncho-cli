import { createStatusRow } from './status-row.js';
import { createWorkRow } from './work-row.js';

/**
 * The two single-row read-outs stacked above the model row: the working-time
 * counter (top) and the status bar with the context-window meter (bottom).
 *
 * They are built together, and here, for one reason: they must be **the same
 * width**. The counter is right-aligned against exactly the column the meter ends
 * at (`composeStatusRow` is the one composer both go through), so a resize re-pins
 * them as a pair and neither can drift a cell away from the other. Keeping the pair
 * in one module also keeps `app/tui.js` below its line budget — it stays the
 * *wiring* of the screen, which is what it was extracted from in the first place.
 *
 * Pure bookkeeping over injected `paint`/`width` hooks, exactly like the two rows
 * it builds: no blessed import, so the pair is testable without a terminal.
 */
export function createStatusRows({
  paintStatus = null,
  paintWork = null,
  width = () => 0,
  initialStatus = 'Ready',
  totals = null,
} = {}) {
  const statusRow = createStatusRow({ paint: paintStatus, width, initialStatus });
  const workRow = createWorkRow({ paint: paintWork, width, totals });

  return {
    statusRow,
    workRow,
    /**
     * Repaint both rows: on construction, and after a resize, so the meter and the
     * counter are re-pinned together instead of one of them keeping the old width.
     */
    render() {
      statusRow.render();
      workRow.render();
      return true;
    },
    /** Install a new working-time snapshot on the counter row. */
    setWork(next) {
      return workRow.setTotals(next);
    },
    /** Release the spinner timer (screen teardown). */
    dispose() {
      statusRow.dispose();
    },
  };
}

/**
 * The rows wired to real widgets: the same pair as above, with the two blessed boxes it
 * paints into and the screen's own width.
 *
 * The wiring lives here rather than in `app/tui.js` for the reason this module exists at
 * all — keeping the screen's wiring below its line budget — and it belongs with the pair
 * because it is the pair's own three facts: the two widgets, the width they are measured
 * against (the screen, less the one-cell margin on each side), and the repaint gate that
 * stops a closed screen from being painted by a spinner that outlived it.
 *
 * `width` is a function of its own and not the caller's, because it has to read the screen
 * on every repaint: a resize changes the answer, and a captured number would pin the meter
 * to the width it had at construction.
 */
export function createWiredStatusRows({
  screen = null, statusBar = null, workBar = null, refresh = () => {},
  columns = null, isClosed = () => false,
} = {}) {
  const screenWidth = () => {
    const width = Number(screen?.width) || Number(columns) || 0;
    return width > 2 ? width - 2 : 0;
  };

  const rows = createStatusRows({
    width: screenWidth,
    paintStatus: (line) => {
      if (isClosed()) return;
      statusBar?.setContent(line);
      refresh();
    },
    paintWork: (line) => {
      if (isClosed()) return;
      workBar?.setContent(line);
      refresh();
    },
  });

  return { ...rows, width: screenWidth };
}
