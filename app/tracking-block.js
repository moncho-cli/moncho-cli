import { TASK_FILE, PLAN_FILE } from '../config/constants.js';
import { readTaskContent, readPlanContent, trackingPaths } from '../utils/tracking-store.js';
import { createTrackingNotifier } from './tracking-notice.js';
import { TRACKING_COLOR, TRACKING_BOLD } from './theme.js';

/**
 * The **block** that shows what a tracking write actually wrote (`docs/interface/tracking-block`).
 *
 * `app/tracking-notice.js` announces the *milestone* — one `[Tracking]` row saying an item
 * was completed or a plan reset. That row says what happened; it never says what the file
 * now contains, so the user has to open `task.md` to see the checklist the agent is working
 * from. This module turns the same write into a second, richer announcement: a titled block
 * carrying the **full content** of the file that changed, in the palette's own contrasting
 * tracking colour (task-backlog: "when the task.md file is created, and each time
 * implementation plan is created, a tui only block with the full content in contrasting
 * color must show, with a title").
 *
 * Three properties are deliberate:
 *
 *  - **TUI only.** A block is what `logBlock` on the transcript pane draws, and the line CLI
 *    has no widget for one — so with no `logBlock` wired there is no block at all, and the
 *    announcement is the `[Tracking]` rows that already existed. The rule is the *presence
 *    of the sink*, never a guess about which front end is up.
 *  - **The content is read back, not remembered.** The block shows what the file really
 *    holds after the write, so a normalised draft, a canonical re-render or a human
 *    hot-edit is shown as it is — never what the tool intended to write.
 *  - **Presentation only.** The block is not a chunk: it never reaches the model context or
 *    a session file, exactly like the rows beside it.
 */

/** The colour the block's payload is painted in: the tracking milestones' own colour. */
export const TRACKING_BLOCK_COLOR = TRACKING_COLOR;

/** Tracking content is a milestone, so the block inherits the bold of its rows. */
export const TRACKING_BLOCK_BOLD = TRACKING_BOLD;

/** The title of the block for one of the two files the protocol owns. */
export const TRACKING_BLOCK_TITLES = Object.freeze({
  task: TASK_FILE,
  plan: PLAN_FILE,
});

/**
 * Which of the two files a write touched.
 *
 * The tools report `taskWritten` / `planWritten` — never a guess about what an action
 * usually does — so a `status` edit that moves no plan shows no plan block, and a ticked
 * step that moves no checklist shows no task block.
 *
 * @param {object} update what `update_task` / `completeStep` reported
 * @returns {string[]} the kinds written, in the protocol's own order (task, then plan)
 */
export function trackingKindsWritten(update = {}) {
  const kinds = [];
  if (update.taskWritten) kinds.push('task');
  if (update.planWritten) kinds.push('plan');
  return kinds;
}

/**
 * One titled block for one tracking file: its header (a title, the file's name and the size
 * it carries) and its body (the file's full content, verbatim).
 *
 * A file with no content still gets a block: "the checklist is empty" is information, and
 * saying so is the honest answer.
 *
 * @param {object} parts
 * @param {string} parts.kind `'task'` or `'plan'`
 * @param {string} [parts.content] the bytes of the file, as read back after the write
 * @param {string} [parts.path] where the file lives, when the caller knows
 * @returns {{header: string, body: string, bodyColor: string, collapsed: boolean}}
 */
export function formatTrackingBlock({ kind, content = '', path = null } = {}) {
  const name = TRACKING_BLOCK_TITLES[kind] || String(kind || 'tracking file');
  const body = String(content ?? '');
  const lines = body === '' ? 0 : body.replace(/\n$/, '').split('\n').length;
  const where = path ? ` (${path})` : '';
  return {
    // The title comes first, and the `[Tracking]` marker is what the palette recognises
    // (app/theme.js#classifyLine), so the header paints in the tracking colour too.
    header: `[Tracking] ${name}${where} · full content — ${lines} line${lines === 1 ? '' : 's'}`,
    body: body === '' ? '(empty)' : body,
    // `bodyColor` is the hook app/transcript-view.js#logBlock wraps the payload lines in.
    bodyColor: TRACKING_BLOCK_COLOR,
    // Shown, not folded: the point of the block is that the content is visible.
    collapsed: false,
  };
}

/** Where a kind's content is read from (injectable, so the tests need no session). */
export function trackingReader(kind) {
  return kind === 'task' ? readTaskContent() : readPlanContent();
}

/**
 * Bind the blocks to a front end's block sink.
 *
 * `notify(update)` is the same call `app/tracking-notice.js` receives, so the two
 * announcements of one write come from one place. The return value names the blocks shown,
 * so the caller — and the tests — can see exactly what the user got.
 *
 * @param {object} options
 * @param {Function} [options.logBlock] the transcript's block sink; absent = no block
 * @param {Function} [options.read] `(kind) => content`; defaults to the tracking store
 * @returns {{notify: Function, blocks: Function, shown: number}}
 */
export function createTrackingBlockSink({ logBlock = null, read = trackingReader } = {}) {
  let shown = 0;

  /** One block per file the write touched, in the protocol's order (task, then plan). */
  const blocks = (update = {}) => {
    const paths = trackingPaths();
    return trackingKindsWritten(update).map((kind) => formatTrackingBlock({
      kind,
      content: read(kind) ?? '',
      path: paths[kind],
    }));
  };

  return {
    /**
     * Show the blocks a tracking update earned, or nothing at all.
     *
     * @returns {object[]} the blocks shown, empty with no sink or with nothing written
     */
    notify(update = {}) {
      if (typeof logBlock !== 'function') return [];
      const built = blocks(update);
      for (const block of built) logBlock(block);
      shown += built.length;
      return built;
    },
    /** The blocks one update would produce, without showing them (used by the tests). */
    blocks,
    /** How many blocks have been shown so far. */
    get shown() {
      return shown;
    },
  };
}

/**
 * The whole announcement of one tracking write: the `[Tracking]` rows that say **what
 * happened** and the blocks that show **what the files now hold**.
 *
 * Composing the two here rather than at the call site keeps the host wiring to one call and
 * keeps the TUI-only rule in one place: with no `logBlock` (the line CLI) the block sink is
 * a no-op, so the rows are the whole announcement, exactly as before.
 *
 * @param {object} options
 * @param {Function} [options.log] where the `[Tracking]` rows go
 * @param {Function} [options.logBlock] the transcript's block sink; absent = no block
 * @param {Function} [options.read] `(kind) => content`, for the tests
 * @returns {{notify: Function, blockSink: object}}
 */
export function createTrackingAnnouncer({ log = null, logBlock = null, read = trackingReader } = {}) {
  const notifier = createTrackingNotifier({ log });
  const blockSink = createTrackingBlockSink({ logBlock, read });

  return {
    /**
     * Announce one update: the rows first (they are the short answer), the content blocks
     * after them. Both halves come from this one call, so neither can be forgotten.
     *
     * @returns {string[]} the `[Tracking]` rows shown, as before
     */
    notify(update = {}) {
      const lines = notifier.notify(update);
      blockSink.notify(update);
      return lines;
    },
    get announced() {
      return notifier.announced;
    },
    /** The block half on its own, for a caller that wants the content separately. */
    blockSink,
  };
}
