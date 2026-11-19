import { composeStatusRow } from './tui-render.js';
import { formatWorkRow } from '../utils/working-time.js';

/**
 * The working-time row (task-backlog: "add working time counter to sessions, show
 * next avobe the token window size information row, also aligned to the right").
 *
 * It is the row *above* the status bar, and it is the same shape of thing: a single
 * row whose content is right-aligned against the screen edge. The status bar keeps
 * the window meter, the model row keeps the identity, and this row answers the one
 * question neither of them can: how long has this session actually been working —
 * thinking plus tool calls, idle time excluded (`utils/working-time.js`).
 *
 * Two rules make it behave like the row below it rather than a second status bar:
 *
 *  - it is **right-aligned through the same composer** (`composeStatusRow` with an
 *    empty left slot), so the counter ends at the same column the meter does and a
 *    resize re-pins both;
 *  - it is **empty until there is something to say**: `formatWorkRow()` answers `''`
 *    while no time was worked, and a row that reads `working 0s` from the first
 *    frame only teaches a reader to ignore it. The empty region keeps its row, so
 *    nothing above it moves when the number appears.
 *
 * Pure composition, injected painting: `formatWorkRow()` owns the text and this
 * module owns the layout, so `app/tui.js` stays wiring and the row is testable
 * without a terminal.
 */
export function createWorkRow({ paint = null, width = () => 0, totals = null } = {}) {
  let state = totals && typeof totals === 'object' ? totals : null;

  /** The text the row shows: the counter, or nothing while no time was worked. */
  const line = () => formatWorkRow(state ?? {});

  /** Repaint the row, right-aligned; nothing to say paints nothing. */
  const render = () => {
    const text = line();
    const painted = text ? composeStatusRow('', text, width()) : '';
    if (typeof paint === 'function') paint(painted);
    return painted;
  };

  return {
    render,
    /** Install a new totals snapshot (`{ thinkingMs, toolMs, totalMs }`). */
    setTotals(next) {
      state = next && typeof next === 'object' ? next : null;
      return render();
    },
    /** The text the row would paint right now (empty while nothing was worked). */
    get line() {
      return line();
    },
    get totals() {
      return state;
    },
  };
}
