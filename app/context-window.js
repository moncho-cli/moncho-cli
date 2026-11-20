import {
  CONTEXT_MAX_LENGTH,
  COMPACTION_OLD_RATIO,
  COMPACTION_KEEP_RATIO
} from '../config/constants.js';
import { compactChunks, needsCompaction } from '../utils/compaction.js';
import { estimateRequestTokens, formatUsage } from '../utils/tokens.js';
import { formatContextLimit, CONTEXT_SIZE_SOURCE } from '../utils/context-size.js';

/**
 * The conversation context modelled as an ordered array of chunks (task.md items
 * 3 and 8). Every message pushed by the ConversationManager is a chunk; when the
 * array's estimated token count exceeds CONTEXT_MAX_LENGTH the window compacts
 * itself: the older share (by token mass) is replaced with one summary chunk and
 * the newer share is kept verbatim, with the last user message of the evicted
 * block carried over as written (`utils/compaction.js`). The shares are the
 * configured factors (`config/constants.js#COMPACTION_OLD_RATIO`).
 *
 * Keeping this in its own object (rather than a bare array on the manager) lets
 * the `compact_context` tool reach the *live* window through the host registry.
 *
 * The chunks are the *conversation*: what a request sends is assembled by
 * `request()`, which takes a per-call prelude (the pulse line lived there, see
 * `utils/task-pulse.js`; it is paused and the prelude is empty today). That keeps a
 * message the model must see but the session should not record out of the array, and
 * it is why nothing ever lands between an assistant `tool_calls` chunk and the `tool`
 * chunks answering it.
 */
export class ContextWindow {
  #chunks = [];
  // Every chunk the conversation ever held, appended once and never trimmed by a
  // compaction: the *uncompacted* history (task-backlog: "save a conversation.json …
  // the uncompacted version and has all the chunks all the way back").
  #journal = [];

  constructor({
    maxTokens = CONTEXT_MAX_LENGTH,
    tools = () => [],
    configuredTokens = null,
    realTokens = null,
    source = CONTEXT_SIZE_SOURCE.DEFAULT,
  } = {}) {
    this.maxTokens = maxTokens;
    this.getTools = typeof tools === 'function' ? tools : () => tools || [];
    // Where the limit came from (task.md item 3): a config override may differ
    // from the real total reported by the provider, and the UI shows both.
    this.configuredTokens = configuredTokens;
    this.realTokens = realTokens;
    this.source = source;
    /** Compaction history, newest last (surfaced by the status bar). */
    this.compactions = [];
  }

  get chunks() {
    return this.#chunks;
  }

  /**
   * The uncompacted history: every chunk ever added, in the order it was said.
   *
   * A compaction rewrites `chunks` (the window that is sent) but a chunk that was
   * summarised away is still part of what the conversation *was*, and losing it is
   * losing the only verbatim record of that stretch of work. The journal is therefore
   * append-only: `add()`/`addMany()` write to both, `compact()` touches only the
   * window, and `clear()` is the one operation that empties both, because it means
   * the conversation itself is gone.
   */
  get journal() {
    return this.#journal;
  }

  get length() {
    return this.#chunks.length;
  }

  add(chunk) {
    this.#chunks.push(chunk);
    this.#journal.push(chunk);
    return chunk;
  }

  addMany(chunks) {
    this.#chunks.push(...chunks);
    this.#journal.push(...chunks);
    return this.#chunks.length;
  }

  /**
   * Replace the live window (resuming a stored conversation).
   *
   * `journal` carries the uncompacted history the stored session kept; without it
   * the window itself is the best record available, so the journal restarts from
   * exactly what is being restored rather than from nothing.
   */
  replace(chunks, { journal = null } = {}) {
    this.#chunks = [...chunks];
    this.#journal = Array.isArray(journal) ? [...journal] : [...chunks];
    return this.#chunks.length;
  }

  clear() {
    this.#chunks = [];
    this.#journal = [];
    this.compactions = [];
  }

  /**
   * The exact messages a provider call sends, `extra` first.
   *
   * `api/ollama.js` prepends the agent system prompt, so the order the model reads
   * is: agent prompt, the prelude (today empty — the pulse line is paused, see
   * `utils/task-pulse.js`), the summary of anything that was compacted, then the
   * conversation in order. That prefix only ever grows, which is what lets a provider
   * hit its prompt cache (`docs/context/call-pulse`).
   */
  request(extra = []) {
    const messages = Array.isArray(extra) ? extra : [extra];
    return [...messages.filter(Boolean), ...this.#chunks];
  }

  /** Estimated tokens currently used by the window, tool schemas included. */
  estimatedTokens() {
    return estimateRequestTokens(this.#chunks, this.getTools());
  }

  /**
   * The estimate of a call that also carries `extra`: measured on the messages the
   * request really sends, so the meter accounts for the pulse line too.
   */
  estimatedTokensWith(extra = []) {
    return estimateRequestTokens(this.request(extra), this.getTools());
  }

  /** Usage string such as "1.2k / 8.0k tokens (15%)". */
  usage() {
    const base = formatUsage(this.#chunks, this.maxTokens, this.getTools());
    // When a config override differs from the real total reported by the
    // provider, make that visible: "... [128k configured (total: 1.0M)]".
    if (this.configuredTokens && this.realTokens && this.configuredTokens !== this.realTokens) {
      const label = formatContextLimit(this);
      return `${base} [${label}]`;
    }
    return base;
  }

  /** True when the window no longer fits CONTEXT_MAX_LENGTH. */
  needsCompaction() {
    return needsCompaction(this.#chunks, this.maxTokens, this.getTools());
  }

  /**
   * Compact the window in place.
   *
   * @param {object} options
   * @param {(messages: any[], ctx: object) => Promise<string>} options.callModel
   * @param {AbortSignal} [options.signal]
   * @param {boolean} [options.force] Compact even when the budget is not exceeded.
   * @param {boolean} [options.dryRun]
   * @returns {Promise<object>} compaction report
   */
  async compact({ callModel, signal = null, force = false, dryRun = false, reason = 'over-budget' } = {}) {
    if (!force && dryRun === false && !this.needsCompaction()) {
      return {
        compacted: false,
        reason: 'within-budget',
        usage: this.usage(),
        maxTokens: this.maxTokens,
        chunks: this.#chunks.length
      };
    }

    const result = await compactChunks(this.#chunks, {
      callModel,
      signal,
      dryRun,
      oldRatio: COMPACTION_OLD_RATIO,
      keepRatio: COMPACTION_KEEP_RATIO
    });

    if (result.compacted) {
      this.#chunks = result.chunks;
      const report = {
        at: new Date().toISOString(),
        reason,
        ...result.stats,
        summaryChars: result.summary.length,
        usageAfter: this.usage()
      };
      this.compactions.push(report);
      return { compacted: true, summary: result.summary, reason, usage: this.usage(), ...result.stats };
    }

    return {
      compacted: false,
      reason: result.reason || (result.dryRun ? 'dry-run' : 'nothing-to-compact'),
      usage: this.usage(),
      ...result.stats
    };
  }

  /** Snapshot used by the status bar and the compact_context tool. */
  stats() {
    return {
      chunks: this.#chunks.length,
      // The window that is sent, against the history it was compacted from.
      journalChunks: this.#journal.length,
      maxTokens: this.maxTokens,
      configuredTokens: this.configuredTokens,
      realTokens: this.realTokens,
      source: this.source,
      limit: formatContextLimit(this),
      estimatedTokens: this.estimatedTokens(),
      usage: this.usage(),
      needsCompaction: this.needsCompaction(),
      compactions: this.compactions.length,
      lastCompaction: this.compactions.at(-1) || null
    };
  }
}
