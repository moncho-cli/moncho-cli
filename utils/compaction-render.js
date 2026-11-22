/**
 * The rendering half of a compaction: what a chunk looks like as text, and how the
 * split is described in words.
 *
 * `utils/compaction.js` owns the *decision* — where the window is cut, what is
 * summarised, what the window becomes. This module owns the *words*: how a chunk is
 * written for the summariser, and how the configured split is named.
 *
 * The two are separated for the same reason the provider layer is split in two: a
 * module that does one thing stays small enough to read at once, and the pure half can
 * be proved without a window, a model or a filesystem. Everything here is re-exported
 * from `utils/compaction.js`, so every existing import and every spec keeps naming
 * the same symbols.
 */

import {
  COMPACTION_OLD_RATIO,
  COMPACTION_KEEP_RATIO,
} from '../config/constants.js';

/**
 * The newest chunk the *user* wrote in a list, or `null` when it holds none.
 *
 * This picks the message a compaction carries verbatim out of the block it is
 * about to summarise: a summary paraphrases, and the prompt the user actually
 * typed is the thing that must not drift. The chunk comes back by reference, so
 * it is re-inserted unchanged — no marker added, no field rewritten.
 *
 * @param {any[]} chunks
 * @returns {any|null}
 */
export function lastUserChunk(chunks = []) {
  if (!Array.isArray(chunks)) return null;
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    if (chunks[i]?.role === 'user') return chunks[i];
  }
  return null;
}

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
 * The split, in whole percentages, derived from the configured ratios.
 *
 * Every message that names the split — the CLI budget line, the
 * `compact_context` description and results, the TUI notice — reads it from here
 * rather than repeating a number. The factors come from `config/constants.js`, so
 * an operator who overrides `COMPACTION_OLD_RATIO` sees the same figure the code
 * actually uses, and no message can drift from the code again. The two
 * percentages always sum to 100.
 */
export function describeCompactionSplit({
  oldRatio = COMPACTION_OLD_RATIO,
  keepRatio = COMPACTION_KEEP_RATIO,
} = {}) {
  const oldPercent = Math.round(oldRatio * 100);
  const keepPercent = 100 - oldPercent;
  return {
    oldRatio,
    keepRatio,
    oldPercent,
    keepPercent,
    oldLabel: `${oldPercent}%`,
    keepLabel: `${keepPercent}%`,
    label: `${oldPercent}/${keepPercent}`
  };
}
