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
 * itself: the older 80% (by token mass) is replaced with one summary chunk and
 * the newest 20% is kept verbatim.
 *
 * Keeping this in its own object (rather than a bare array on the manager) lets
 * the `compact_context` tool reach the *live* window through the host registry.
 */
export class ContextWindow {
  #chunks = [];

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

  get length() {
    return this.#chunks.length;
  }

  add(chunk) {
    this.#chunks.push(chunk);
    return chunk;
  }

  addMany(chunks) {
    this.#chunks.push(...chunks);
    return this.#chunks.length;
  }

  replace(chunks) {
    this.#chunks = [...chunks];
    return this.#chunks.length;
  }

  clear() {
    this.#chunks = [];
    this.compactions = [];
  }

  /** Estimated tokens currently used by the window, tool schemas included. */
  estimatedTokens() {
    return estimateRequestTokens(this.#chunks, this.getTools());
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
