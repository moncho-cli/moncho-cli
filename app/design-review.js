import { TASK_FILE } from '../config/constants.js';
import { readTaskContent, trackingPaths } from '../utils/tracking-store.js';
import { CONVERSATION_COLORS } from './theme.js';

/**
 * The checklist put back on screen when a `design` turn ends (`docs/interface/design-review`).
 *
 * `design` is the mode whose whole job is turning a discussion into a checklist
 * (`docs/interface/modes`), and the file it produces is the thing the user is meant to be
 * reviewing. Until this module existed they had to type `/task` after every turn to see it —
 * so the review is done **by the host**, deterministically, at the one moment it is useful:
 * the thinking stopped and the session is waiting for a person again.
 *
 * Three properties are deliberate, and each is a decision rather than an accident:
 *
 *  - **the model is not involved.** No tool call, no instruction in the prompt, nothing the
 *    model has to remember: the turn boundary is the host's to observe, so waiting for the
 *    model to print its own checklist would make the behaviour something the agent may or may
 *    not do. It is code, and it happens in `chat` and `work` not at all.
 *  - **it is presentation only.** The block goes to the transcript's own block sink
 *    (`logBlock`), which is the route every other view-only announcement takes
 *    (`app/tracking-block.js`) — never a chunk, never a session file, never in the request
 *    sent to the provider. "Print it in the user conversation, not the model context" is this
 *    one line, not a promise.
 *  - **an unchanged checklist is not re-dumped.** A review is worth reading because it says
 *    what changed; a design turn that touched no file would otherwise repeat the same sixty
 *    lines after every exchange. The rule is still deterministic — the bytes are compared
 *    against the bytes last shown — it just refuses to say the same thing twice.
 */

/**
 * Whether a state is the one this behaviour belongs to: `design`, with no execution lock.
 *
 * Read from the live mode object on every turn (`docs/interface/modes`), so a `Tab` pressed
 * mid-session moves the behaviour with it — and `work:on` pins the mode to `work`, so the
 * lock is already covered by the mode test rather than by a second one.
 *
 * @param {{mode?: string}|null} mode a `createSessionMode()`
 * @returns {boolean}
 */
export function shouldReviewDesign(mode) {
  return mode?.mode === 'design';
}

/** The colour the block's payload is painted in: the tracking milestones' own colour. */
function reviewColor() {
  return CONVERSATION_COLORS.tracking;
}

/**
 * The block for one review: a titled header and the checklist's own bytes.
 *
 * The shape is `formatTrackingBlock()`'s on purpose — the header comes first, the payload
 * after it, and `bodyColor` is the hook `app/transcript-view.js#logBlock` wraps the payload
 * lines in — so a review reads as the same family as a tracking write instead of as a second
 * kind of thing on screen.
 *
 * @param {object} parts
 * @param {string} [parts.content] `task.md`'s bytes
 * @param {string} [parts.path] where it lives, when the caller knows
 * @returns {{header: string, body: string, bodyColor: string, collapsed: boolean}}
 */
export function formatDesignReview({ content = '', path = null } = {}) {
  const body = String(content ?? '');
  const lines = body === '' ? 0 : body.replace(/\n$/, '').split('\n').length;
  const where = path ? ` (${path})` : '';
  return {
    header: `[Tracking] ${TASK_FILE}${where} · design review — ${lines} line${lines === 1 ? '' : 's'}`,
    body: body === '' ? '(empty)' : body,
    bodyColor: reviewColor(),
    // Shown, not folded: the point of the review is that the checklist is on screen.
    collapsed: false,
  };
}

/**
 * Build the reviewer.
 *
 * `maybeShow()` is the whole interface the loop needs, and it answers what it did so both the
 * host and the tests can see it: `false` when the mode is not `design`, when there is no
 * checklist, when there is no block sink (the line CLI) or when nothing changed since the last
 * review; `true` when a review was shown.
 *
 * @param {object} options
 * @param {object|null} [options.mode] the session mode, read live
 * @param {Function} [options.logBlock] the transcript's block sink; absent = no review
 * @param {Function} [options.readTask] the reader (injectable, so the tests need no session)
 * @returns {{maybeShow: Function, reset: Function, describe: Function}}
 */
export function createDesignReview({
  mode = null,
  logBlock = null,
  readTask = undefined,
} = {}) {
  let lastShown = null;
  let shown = 0;

  return {
    /**
     * Show the review a finished `design` turn earned, or do nothing at all.
     *
     * @returns {boolean} whether a block was shown
     */
    maybeShow() {
      if (!shouldReviewDesign(mode)) return false;
      if (typeof logBlock !== 'function') return false;

      let content = null;
      try {
        content = readTaskContent(readTask);
      } catch {
        // Reading is a courtesy here: a task.md that cannot be read must never cost the user
        // the turn that just landed, so the review is simply skipped.
        return false;
      }
      // No checklist yet is silence rather than an empty box: a design session that has not
      // started tracking has nothing to review.
      if (typeof content !== 'string') return false;
      if (content === lastShown) return false;

      lastShown = content;
      shown += 1;
      logBlock(formatDesignReview({ content, path: trackingPaths().task ?? null }));
      return true;
    },

    /** Forget what was shown, so the next turn reviews the checklist again. */
    reset() {
      lastShown = null;
      shown = 0;
    },

    /** For diagnostics and the tests: what the reviewer has done so far. */
    describe() {
      return { shown, hasShown: lastShown !== null };
    },
  };
}
