import {
  COMPACTION_OLD_RATIO,
  COMPACTION_KEEP_RATIO,
  COMPACTION_SUMMARY_PREFIX
} from '../config/constants.js';
import { estimateMessageTokens, estimateMessagesTokens, exceedsTokenBudget } from './tokens.js';

/**
 * Context-window compaction (task.md item 8).
 *
 * The context window is modelled as an ordered array of *chunks* (chat
 * messages). When its token count exceeds CONTEXT_MAX_LENGTH the older 80% of
 * the window (by token mass) is replaced by a single summarised chunk while the
 * newest 20% is kept verbatim.
 *
 * The split and the assembly are pure functions so they can be unit-tested
 * without a model; only the summary text needs a model call, which is injected
 * as `callModel` to keep this module provider-agnostic.
 */

export const SUMMARIZER_SYSTEM_PROMPT = [
  'You are the context-compaction component of a coding agent.',
  'You receive the older part of a conversation window that is about to be evicted.',
  'Produce a brief but thorough summary, in markdown, that a fresh agent could use to continue the work.',
  'Always cover, in this order:',
  '1. Original intent - what the user asked for and the constraints in force.',
  '2. Tasks done - completed work, decisions taken, and how each was verified.',
  '3. Things pending - remaining work, open questions and blockers.',
  '4. Key facts - file paths, commands, tool outputs, identifiers and errors worth remembering.',
  'Do not add preamble, apologies or meta commentary. Output only the summary.'
].join('\n');

/** Render one chunk as text for the summariser prompt. */
export function chunkToText(chunk) {
  if (chunk === null || chunk === undefined) return '';
  if (typeof chunk === 'string') return chunk;

  const role = chunk.role || 'chunk';
  const parts = [];
  if (typeof chunk.content === 'string' && chunk.content.length > 0) {
    parts.push(chunk.content);
  } else if (chunk.content !== undefined && chunk.content !== null) {
    parts.push(JSON.stringify(chunk.content));
  }
  if (typeof chunk.thinking === 'string' && chunk.thinking.length > 0) {
    parts.push(`[thinking]\n${chunk.thinking}`);
  }
  if (Array.isArray(chunk.tool_calls) && chunk.tool_calls.length > 0) {
    parts.push(`[tool_calls]\n${JSON.stringify(chunk.tool_calls)}`);
  }
  if (chunk.tool_call_id) parts.push(`[tool_call_id] ${chunk.tool_call_id}`);
  return `[${role}]\n${parts.join('\n')}`.trimEnd();
}

/** Serialise a list of chunks into the single text block sent to the summariser. */
export function serializeChunks(chunks) {
  return chunks.map(chunkToText).filter(Boolean).join('\n\n---\n\n');
}

/**
 * Split an ordered chunk list into the older block to summarise and the newer
 * block to keep, using token mass rather than chunk count so a couple of huge
 * chunks cannot skew the 80/20 split.
 *
 * @returns {{older: any[], kept: any[], olderTokens: number, keptTokens: number, totalTokens: number}}
 */
export function splitByTokenBudget(
  chunks,
  { oldRatio = COMPACTION_OLD_RATIO, keepRatio = COMPACTION_KEEP_RATIO } = {}
) {
  if (!Array.isArray(chunks)) {
    throw new TypeError('splitByTokenBudget expects an array of chunks.');
  }
  if (chunks.length <= 1) {
    return { older: [], kept: [...(chunks || [])], olderTokens: 0, keptTokens: estimateMessagesTokens(chunks), totalTokens: estimateMessagesTokens(chunks) };
  }

  const counts = chunks.map(estimateMessageTokens);
  const totalTokens = counts.reduce((sum, value) => sum + value, 0);
  const keepTarget = totalTokens * keepRatio;

  let keptTokens = 0;
  let startIndex = chunks.length;
  for (let i = chunks.length - 1; i >= 0; i--) {
    keptTokens += counts[i];
    startIndex = i;
    if (keptTokens >= keepTarget) break;
  }

  // Never evict everything: at least the newest chunk always survives.
  if (startIndex <= 0) startIndex = Math.max(1, chunks.length - 1);
  if (chunks.length - startIndex < 1) startIndex = chunks.length - 1;

  const older = chunks.slice(0, startIndex);
  const kept = chunks.slice(startIndex);
  return {
    older,
    kept,
    olderTokens: totalTokens - keptTokens,
    keptTokens,
    totalTokens,
    oldRatio,
    keepRatio
  };
}

/** Build the user message handed to the summariser model. */
export function buildSummaryPrompt(chunks) {
  return [
    `Summarise the following ${chunks.length} context chunk(s) for the compaction window.`,
    '',
    serializeChunks(chunks)
  ].join('\n');
}

/** Wrap a summary so it is recognisable as a compacted chunk in the window. */
export function buildSummaryChunk(summary, { summarizedChunks = 0, prefix = COMPACTION_SUMMARY_PREFIX } = {}) {
  return {
    role: 'system',
    content: `${prefix}\n${String(summary).trim()}`,
    compacted: true,
    summarized_chunks: summarizedChunks
  };
}

/**
 * Compact a chunk list: summarise the older block and prepend it to the kept block.
 *
 * @param {any[]} chunks
 * @param {object} options
 * @param {(messages: any[], ctx: object) => Promise<string>} options.callModel
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.dryRun] Skip the model call and only report the split.
 * @returns {Promise<{chunks: any[], summary: string|null, compacted: boolean, stats: object}>}
 */
export async function compactChunks(chunks, options = {}) {
  const {
    callModel,
    signal = null,
    dryRun = false,
    oldRatio = COMPACTION_OLD_RATIO,
    keepRatio = COMPACTION_KEEP_RATIO,
    summaryPrefix = COMPACTION_SUMMARY_PREFIX
  } = options;

  const split = splitByTokenBudget(chunks, { oldRatio, keepRatio });
  const stats = {
    totalChunks: chunks.length,
    olderChunks: split.older.length,
    keptChunks: split.kept.length,
    totalTokens: split.totalTokens,
    olderTokens: split.olderTokens,
    keptTokens: split.keptTokens,
    afterTokens: split.keptTokens
  };

  if (split.older.length === 0) {
    return { chunks: [...chunks], summary: null, compacted: false, reason: 'nothing_to_compact', stats };
  }

  if (dryRun) {
    return { chunks: [...chunks], summary: null, compacted: false, dryRun: true, stats };
  }

  if (typeof callModel !== 'function') {
    throw new TypeError('compactChunks requires a callModel function (or dryRun: true).');
  }

  const promptMessages = [
    { role: 'system', content: SUMMARIZER_SYSTEM_PROMPT },
    { role: 'user', content: buildSummaryPrompt(split.older) }
  ];

  const summary = await callModel(promptMessages, { signal, purpose: 'context-compaction' });
  if (typeof summary !== 'string' || summary.trim() === '') {
    throw new Error('The summariser returned an empty summary; the context window was left unchanged.');
  }

  const summaryChunk = buildSummaryChunk(summary, {
    summarizedChunks: split.older.length,
    prefix: summaryPrefix
  });

  const nextChunks = [summaryChunk, ...split.kept];
  const afterTokens = estimateMessagesTokens(nextChunks);

  return {
    chunks: nextChunks,
    summary,
    compacted: true,
    stats: { ...stats, afterTokens }
  };
}

/** True when the chunk list no longer fits the configured budget. */
export function needsCompaction(chunks, maxTokens, tools = []) {
  return exceedsTokenBudget(chunks, maxTokens, tools);
}
