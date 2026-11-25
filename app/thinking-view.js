import fs from 'fs';

import { THINKING_FILE } from '../config/constants.js';
import { resolveProjectPath } from '../utils/path-safety.js';
import { displayWidth, clustersWithin } from './cell-width.js';

/**
 * The `Thinking` label as a door onto the reasoning stream (backlog item 37).
 *
 * The provider's reasoning already reaches the disk: `api/ollama.js` clears
 * `THINKING_FILE` at the start of every streaming call and appends each delta to
 * it (`config/constants.js#THINKING_FILE`, `agent/thinking.md` by default). Nothing
 * here captures anything — this module only makes that file *readable from the
 * screen*, through the modal `/task` already uses (`app/content-modal.js`).
 *
 * Two facts decide the whole shape:
 *
 *  - **the label is only a target while it is up.** The left slot carries the
 *    spinner's frame during a request and the logical status text between turns
 *    (`app/status-row.js#leftText`). Clicking `Ready` must do nothing, so the
 *    binder asks `isSpinning()` before it looks at a cell at all.
 *  - **the hit zone is measured, not guessed.** The row is composed by
 *    `composeStatusRow`, which pads the meter to the right edge and truncates the
 *    left slot when the two do not fit — between grapheme clusters, never inside
 *    one. A zone computed from the label's own width would be wrong on exactly the
 *    narrow terminal where the label is truncated, so `thinkingHitZone()` repeats
 *    the composer's arithmetic against the same two strings and the same width.
 *
 * The zone is a half-open interval of **cells** from the content's left edge, the
 * unit a mouse report arrives in. `leftPad` is the box's own left padding
 * (`app/tui-layout.js`), so the interval can be stated against the widget origin
 * the event is measured from.
 */

/** Where the thinking capture lives when the environment says nothing. */
export const THINKING_DOCUMENT_NAME = 'thinking';

/** The modal's title, and the one word the reader sees. */
export const THINKING_VIEW_TITLE = 'Thinking';

/**
 * Read the reasoning capture, forgivingly.
 *
 * A missing file is the ordinary state — a session that has not made a streaming
 * call yet — and an unreadable one is a half-written capture. Neither may throw:
 * the cost of a broken reading is an empty view, which is what `null` means here.
 *
 * @param {object} [options]
 * @param {string} [options.file] the capture path, resolved through the sandbox
 * @param {Function} [options.readFile] injectable reader, for the tests
 * @returns {{path: string, text: string}|null} the capture, or `null` when there is none
 */
export function readThinkingCapture({
  file = THINKING_FILE,
  readFile = (target) => fs.readFileSync(target, 'utf-8'),
} = {}) {
  let absolute = null;
  try {
    absolute = resolveProjectPath(file);
  } catch {
    // A capture outside the project is not a capture this program will read.
    return null;
  }
  try {
    const text = readFile(absolute);
    if (typeof text !== 'string') return null;
    return { path: file, text };
  } catch {
    return null;
  }
}

/**
 * The documents the viewer shows: the capture, or nothing at all.
 *
 * An empty capture is deliberately **not** a document. `openContentModal` resolves
 * `null` for an empty list (`app/content-modal.js`), which is exactly the wanted
 * answer — a click a moment before the first delta arrives opens nothing rather
 * than an empty box that would have to be dismissed.
 *
 * @param {{path: string, text: string}|null} capture
 * @returns {Array<{name: string, path: string, text: string}>}
 */
export function thinkingDocuments(capture) {
  if (!capture || typeof capture.text !== 'string' || capture.text.trim() === '') return [];
  return [{ name: THINKING_DOCUMENT_NAME, path: capture.path, text: capture.text }];
}

/**
 * The viewer spec a front end can open, or `null` when there is nothing to show.
 *
 * Shaped exactly like the one `/task` builds (`app/task-command.js#taskCommand`):
 * a title, the documents, and a `reload()` the box calls on its own timer. The
 * re-read is the point — a stream is written *while* the box is open, so a
 * snapshot would show the reasoning a reader already finished thinking about.
 *
 * @param {object} [options]
 * @param {string} [options.file]
 * @param {Function} [options.readFile]
 * @returns {{title: string, documents: Array<object>, reload: Function}|null}
 */
export function thinkingView({ file = THINKING_FILE, readFile } = {}) {
  const read = () => readThinkingCapture({ file, readFile });
  const documents = thinkingDocuments(read());
  if (documents.length === 0) return null;
  return {
    title: THINKING_VIEW_TITLE,
    documents,
    reload: () => thinkingDocuments(read()),
  };
}

/**
 * The cells the left slot occupies, as `[start, end)` from the content's left edge.
 *
 * Mirrors `app/tui-render.js#composeStatusRow` branch for branch, because the
 * painted row is what the reader is pointing at:
 *
 *  - no usable width — the row is left and meter joined by one space;
 *  - no meter — the left slot is the whole row;
 *  - no left slot — there is nothing to aim at;
 *  - room to spare — the left slot is painted whole;
 *  - no room — it is cut to `width - meterCells - 1` **between clusters**, the
 *    same cut the composer makes.
 *
 * @param {object} [options]
 * @param {string} [options.left] the left slot as painted (`statusRow.leftText()`)
 * @param {string} [options.right] the meter
 * @param {number} [options.width] the composed width in cells
 * @param {number} [options.leftPad] the box's left padding
 * @returns {{start: number, end: number}|null} the interval, or `null` if empty
 */
export function thinkingHitZone({
  left = '', right = '', width = 0, leftPad = 0,
} = {}) {
  const leftText = String(left ?? '');
  const rightText = String(right ?? '');
  if (leftText === '') return null;

  const pad = Number(leftPad) > 0 ? Number(leftPad) : 0;
  const total = Number(width) || 0;
  const rightCells = displayWidth(rightText);

  let cells = displayWidth(leftText);
  if (total > 0 && rightText) {
    const gap = total - cells - rightCells;
    if (gap <= 0) cells = displayWidth(clustersWithin(leftText, Math.max(0, total - rightCells - 1)).join(''));
  }

  if (cells <= 0) return null;
  return { start: pad, end: pad + cells };
}

/**
 * Did a click land on the label?
 *
 * The row is one cell tall, and every report that reaches it is a press on the
 * row itself, so only the column has to be tested. An event with no usable
 * coordinate — a synthetic one, a broken report — is not a hit: a label that
 * opens a modal on a guess is worse than one that misses.
 *
 * The event's column is **absolute**, measured from the screen's left edge (that is
 * how blessed reports it, and how `app/queue-bar.js#clickAt` reads it), while the
 * zone is relative to the box — so the box's own origin, `origin`, is added back.
 * A caller with no origin is measuring from the screen edge, which is the same
 * thing for a box at column 0.
 *
 * @param {{x?: number}} data the blessed mouse event
 * @param {{start: number, end: number}|null} zone
 * @param {number} [origin] the box's left edge in screen columns
 * @returns {boolean}
 */
export function clickedThinkingLabel(data, zone, origin = 0) {
  if (!zone) return false;
  const x = Number(data?.x);
  if (!Number.isFinite(x)) return false;
  const left = Number(origin) > 0 ? Number(origin) : 0;
  const cell = x - left;
  return cell >= zone.start && cell < zone.end;
}

/**
 * Wire the label to the viewer.
 *
 * Called after the surface exists, because the modal is the surface's own
 * (`app/tui-surface.js#createTuiSurface`'s `contentView`) — the same one `/task`
 * opens, so the box, its selection, its copy and its keyboard lease are not
 * re-implemented here. Three rules keep the click from being a nuisance:
 *
 *  - **nothing happens between turns.** The zone is read only while the spinner
 *    is up, so the ordinary status text is never a target;
 *  - **the click is consumed only by a hit.** Every other click on the row falls
 *    through, so the status bar behaves exactly as before;
 *  - **a failing open is swallowed.** A click is a keystroke-like event: a modal
 *    that throws must report through `notify` and never into the event loop.
 *
 * @param {object} options
 * @param {object} options.statusBar the blessed box the row is painted into
 * @param {object} options.statusRow the row's model (`leftText`, `meterText`, `isSpinning`)
 * @param {Function} options.width the composed width in cells
 * @param {Function} options.contentView the surface's modal opener
 * @param {Function} [options.buildView] builds the viewer spec
 * @param {Function} [options.notify] reports a failure
 * @param {number} [options.leftPad] the box's left padding
 * @returns {{dispose: Function}} the binding, for a test and for teardown
 */
export function bindThinkingClick({
  statusBar = null,
  statusRow = null,
  width = () => 0,
  contentView = null,
  buildView = thinkingView,
  notify = null,
  leftPad = 1,
} = {}) {
  if (!statusBar || typeof statusBar.on !== 'function' || !statusRow) {
    return { dispose: () => {} };
  }
  if (typeof contentView !== 'function') return { dispose: () => {} };

  const handler = (data) => {
    if (typeof statusRow.isSpinning === 'function' && !statusRow.isSpinning()) return false;
    const zone = thinkingHitZone({
      left: statusRow.leftText?.() ?? '',
      right: statusRow.meterText ?? '',
      width: width(),
      leftPad,
    });
    // The report's column is absolute; the widget's own left edge is what turns it
    // into a cell inside the row.
    const origin = Number(statusBar.lpos?.xi) || 0;
    if (!clickedThinkingLabel(data, zone, origin)) return false;
    try {
      const view = buildView();
      if (!view) {
        // The label was a target and the capture was not there. Saying so is the
        // difference between "nothing happened" and "there is nothing yet": the
        // silent version of this branch is what made a working binding read as a
        // dead one (a call that has not written its reasoning yet leaves no file).
        if (typeof notify === 'function') {
          notify(new Error('no reasoning captured yet for this call'));
        }
        return true;
      }
      Promise.resolve(contentView(view)).catch((error) => notify?.(error));
      return true;
    } catch (error) {
      if (typeof notify === 'function') notify(error);
      return true;
    }
  };

  statusBar.on('click', handler);
  return {
    dispose() {
      if (typeof statusBar.removeListener === 'function') statusBar.removeListener('click', handler);
    },
  };
}