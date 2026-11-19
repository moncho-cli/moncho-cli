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
