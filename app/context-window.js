import {
  CONTEXT_MAX_LENGTH,
  COMPACTION_OLD_RATIO,
  COMPACTION_KEEP_RATIO
} from '../config/constants.js';
import { compactChunks, needsCompaction } from '../utils/compaction.js';
import { estimateRequestTokens, formatUsage } from '../utils/tokens.js';
import { formatContextLimit, CONTEXT_SIZE_SOURCE } from '../utils/context-size.js';
import { alignStamps, normalizeStamps, stampRepeated } from '../utils/chunk-stamps.js';
import { alignItems, collapseCompletedItems, normalizeItems, NO_ITEM } from '../utils/item-collapse.js';
import { buildChunkMeta, metaRepeated, normalizeMeta } from '../utils/chunk-meta.js';

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
  // The append time of each chunk in `#chunks`, index-aligned and never on the chunk
  // itself (utils/chunk-stamps.js): the chunks are what the provider is sent verbatim,
  // so the bookkeeping cannot ride on them. Presentation only — see `stamps`.
  #stamps = [];
  // The provenance of each chunk in `#journal`, index-aligned with it and never on a
  // chunk (utils/chunk-meta.js): the journal holds the *same objects* the window does,
  // and a chunk is sent to the provider verbatim, so a bookkeeping field would be sent
  // and stored. Aligned with the journal rather than the window because the journal is
  // append-only — a compaction never rebuilds it, so an entry is never re-aligned.
  #journalMeta = [];
  // The `task.md` item each chunk in `#chunks` belongs to, index-aligned and never on
  // the chunk itself (utils/item-collapse.js), for the same reason the marks are not:
  // a chunk is sent verbatim. Set by `update_task`, so nothing here guesses.
  #items = [];
  // The item a chunk appended *now* would belong to. Set by `update_task` through the
  // registry (`utils/host.js#setCurrentItem`); `NO_ITEM` means "no item in flight",
  // which is what every chunk added while no item is open is attributed to.
  #currentItem = NO_ITEM;

  constructor({
    maxTokens = CONTEXT_MAX_LENGTH,
    tools = () => [],
    configuredTokens = null,
    realTokens = null,
    source = CONTEXT_SIZE_SOURCE.DEFAULT,
    now = () => new Date(),
    monchoVersion = null,
  } = {}) {
    // The clock the marks are taken from. Injected, so a test names the exact time and
    // the TUI is not the only front end that can produce marks.
    this.now = typeof now === 'function' ? now : () => new Date();
    // **Moncho's** version — the build every chunk appended from now on is stamped with
    // (utils/chunk-meta.js). Never the version of the project being worked in: the name
    // says whose it is, and the value is resolved module-relative by the caller
    // (`app/brand.js`), so it cannot be confused with a user's `package.json`.
    this.monchoVersion = typeof monchoVersion === 'string' && monchoVersion.trim() !== ''
      ? monchoVersion.trim()
      : null;
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

  /**
   * The provenance of each journal chunk, index-aligned with `journal`
   * (`utils/chunk-meta.js`, `docs/runtime/chunk-provenance`).
   *
   * One entry per journal chunk, always — a chunk with nothing known is `null`, never a
   * shorter array that would shift every later entry onto the wrong row. Aligned with the
   * journal rather than the window because the journal is append-only: a compaction never
   * rebuilds it, so an entry is written once and never re-aligned. Never sent to the
   * provider, and never on a chunk.
   */
  get journalMeta() {
    return this.#journalMeta;
  }

  get length() {
    return this.#chunks.length;
  }

  /**
   * The append time of each chunk, index-aligned with `chunks` (alias: `chunkStamps`).
   *
   * A chunk without a known time is `null` and the array is never shorter than the
   * window, so index `i` always answers for chunk `i`. Presentation only: these marks
   * are stored in the session file beside the chunks and replayed into the transcript
   * on a resume (`docs/interface/session-stamps`), and they are never sent to the
   * provider.
   */
  get stamps() {
    return this.#stamps;
  }

  /**
   * The `task.md` item each chunk belongs to, index-aligned with `chunks`.
   *
   * `null` (`NO_ITEM`) means "not provably part of any item", which is the answer for
   * every chunk added while no item was open — and the reason the collapse refuses to
   * touch it. Host state, never a chunk: it is set by `update_task` through the registry
   * (`utils/host.js#setCurrentItem`) and never sent to the provider.
   */
  get items() {
    return this.#items;
  }

  /**
   * The item the next chunk appended will belong to.
   *
   * Set by `update_task` (`start` opens an item, `complete` moves to the next one) and
   * cleared when the checklist finishes. `null` means "no item in flight", and a chunk
   * added then is attributed to nothing rather than to a guess.
   */
  get currentItem() {
    return this.#currentItem;
  }

  setCurrentItem(item) {
    this.#currentItem = typeof item === 'string' && item.trim() !== '' ? item.trim() : NO_ITEM;
    return this.#currentItem;
  }

  /** The one mark a chunk appended *now* would carry, or `null` for an unreadable clock. */
  #nowStamp() {
    const at = this.now();
    return stampRepeated(at, 1)[0] ?? null;
  }

  add(chunk) {
    this.#chunks.push(chunk);
    this.#journal.push(chunk);
    this.#stamps.push(this.#nowStamp());
    this.#items.push(this.#currentItem);
    // The provenance is taken *once*, as the chunk enters: the version that produced it
    // and what it weighed are facts about this moment, and neither can be recovered later.
    this.#journalMeta.push(buildChunkMeta(chunk, { moncho: this.monchoVersion }));
    return chunk;
  }

  addMany(chunks) {
    const list = Array.isArray(chunks) ? chunks : [];
    this.#chunks.push(...list);
    this.#journal.push(...list);
    // One clock reading for the batch: a tool batch's chunks are one moment, not several.
    this.#stamps.push(...stampRepeated(this.now(), list.length));
    // One attribution for the batch: a tool batch is one stretch of work on one item.
    this.#items.push(...list.map(() => this.#currentItem));
    this.#journalMeta.push(...metaRepeated(list, { moncho: this.monchoVersion }));
    return this.#chunks.length;
  }

  /**
   * Replace the live window (resuming a stored conversation).
   *
   * `journal` carries the uncompacted history the stored session kept; without it
   * the window itself is the best record available, so the journal restarts from
   * exactly what is being restored rather than from nothing.
   *
   * `stamps` carries the append times the record kept beside the same chunks; a record
   * written before they existed (or a caller that only knows the chunks) yields no
   * marks, which is what a stored conversation shows when its times were never written.
   *
   * `meta` carries the provenance the record kept beside the *journal* (`utils/chunk-meta.js`),
   * so a resumed conversation goes on saying which build wrote each chunk. A record written
   * before the field existed yields no entries, which is honest rather than wrong.
   */
  replace(chunks, { journal = null, stamps = null, items = null, meta = null } = {}) {
    this.#chunks = [...chunks];
    this.#journal = Array.isArray(journal) ? [...journal] : [...chunks];
    this.#stamps = normalizeStamps(Array.isArray(stamps) ? stamps : [], this.#chunks.length);
    this.#items = normalizeItems(Array.isArray(items) ? items : [], this.#chunks.length);
    // Aligned with the journal, not the window: that is the list the entries describe, and
    // the one a compaction never rebuilds.
    this.#journalMeta = normalizeMeta(Array.isArray(meta) ? meta : [], this.#journal.length);
    return this.#chunks.length;
  }

  clear() {
    this.#chunks = [];
    this.#journal = [];
    this.#stamps = [];
    this.#items = [];
    this.#journalMeta = [];
    this.#currentItem = NO_ITEM;
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
      // The marks follow their chunks by identity: the summary is a new chunk and takes
      // the moment of the compaction, while the carried user message and the kept tail
      // keep the times they were written (utils/chunk-stamps.js#alignStamps).
      this.#stamps = alignStamps({
        previousChunks: this.#chunks,
        previousStamps: this.#stamps,
        nextChunks: result.chunks,
        fallback: this.#nowStamp(),
      });
      // The attributions follow their chunks the same way: the summary is new and
      // belongs to no item, while the carried user message and the kept tail keep the
      // item they were written under (utils/item-collapse.js#alignItems).
      this.#items = alignItems({
        previousChunks: this.#chunks,
        previousItems: this.#items,
        nextChunks: result.chunks,
        fallback: NO_ITEM,
      });
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

  /**
   * Collapse every completed item's section into one deterministic chunk.
   *
   * The window shrinks without a model call: the runs come from the attributions
   * `update_task` set, and only a run that is provably one *completed* item, long enough
   * to be worth it, safe around tool batches and smaller once summarised is replaced
   * (`utils/item-collapse.js`). Everything else stays verbatim, and the uncompacted
   * history is the journal, so nothing is lost by collapsing.
   *
   * @param {object} [options]
   * @param {Iterable<string>} [options.completed] the items known to be done
   * @param {(run: object) => (number|object|null)} [options.writeCapture] persists a run
   * @returns {{collapsed: object[], chunks: number}} what was collapsed and the new size
   */
  collapseCompleted({ completed = [], writeCapture = null } = {}) {
    const result = collapseCompletedItems(this.#chunks, this.#items, { completed, writeCapture });
    if (result.collapsed.length === 0) return { collapsed: [], chunks: this.#chunks.length };
    this.#chunks = result.chunks;
    this.#items = result.items;
    return { collapsed: result.collapsed, chunks: this.#chunks.length };
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
