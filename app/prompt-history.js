/**
 * The prompts already sent, walked with the up/down arrows (task-backlog: "up/down
 * to navigate messages history").
 *
 * Pure: a list, a cursor into it and nothing else — no widget, no terminal, no
 * file. `app/prompt-editor.js` is what binds a walk to the input box.
 *
 * One rule shapes the walk: **what the user was typing is never lost.** The value
 * the box held when the walk started is the *draft*, and walking past the newest
 * entry lands back on exactly that draft, so pressing up and then down always
 * returns the box to where it was.
 */

/** How many prompts the walk keeps, newest last. */
export const HISTORY_LIMIT = 100;

/**
 * @param {object} [options]
 * @param {number} [options.limit] how many entries to keep (`HISTORY_LIMIT`)
 */
export function createPromptHistory({ limit = HISTORY_LIMIT } = {}) {
  const max = Math.max(1, Math.trunc(Number(limit)) || HISTORY_LIMIT);
  /** Oldest first, newest last. */
  const entries = [];
  /** -1 means "not walking": the box shows the draft. */
  let index = -1;
  /** What the box held when the walk began. */
  let draft = '';

  const reset = () => {
    index = -1;
    draft = '';
    return index;
  };

  return {
    /**
     * Remember one prompt. A blank submission is not a prompt and the `exit`
     * sentinel is not one either (`app/input-hint.js` treats both the same way), a
     * repeat of the newest entry is not stored twice, and a record always ends any
     * walk in progress — the box shows the draft again.
     */
    record(text) {
      const value = String(text ?? '');
      reset();
      if (!value.trim()) return entries.length;
      if (entries[entries.length - 1] === value) return entries.length;
      entries.push(value);
      while (entries.length > max) entries.shift();
      return entries.length;
    },

    /**
     * The previous prompt, going back in time. `current` is stashed as the draft on
     * the first step. Returns null when there is nothing to recall, in which case
     * the key is left to the input box.
     */
    prev(current) {
      if (entries.length === 0) return null;
      if (index === -1) {
        draft = String(current ?? '');
        index = entries.length - 1;
      } else if (index > 0) {
        index -= 1;
      }
      return entries[index];
    },

    /**
     * The next prompt, going forward in time; past the newest entry the draft comes
     * back and the walk ends. Returns null when no walk is in progress.
     */
    next() {
      if (index === -1) return null;
      index += 1;
      if (index >= entries.length) {
        const back = draft;
        reset();
        return back;
      }
      return entries[index];
    },

    reset,
    /** The prompts kept, oldest first (a copy: the caller cannot mutate the walk). */
    get entries() {
      return entries.slice();
    },
    /** The position in the walk, or -1 when the box shows the draft. */
    get index() {
      return index;
    },
    /** How many prompts are kept. */
    get size() {
      return entries.length;
    },
    /** What the box held when the walk began. */
    get draft() {
      return draft;
    },
    /** True while the up/down walk is in progress. */
    get walking() {
      return index !== -1;
    },
  };
}
