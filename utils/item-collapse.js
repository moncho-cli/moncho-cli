/**
 * Which `task.md` item each chunk belongs to, and the deterministic collapse of a
 * completed item's section.
 *
 * The backlog entry:
 *
 * > because the conversation is saved as chunks with the messages inside, and we
 * > usually can deterministically know which items from task.md we are solving, if we
 * > save that information in the chunks (the relation to what item) we can
 * > deterministically compact all that section into a single paragraph hiding all the
 * > reasoning and tool calls and other whats, the model at that point only needs to
 * > know that was solved, if it needs anything it can query back again. this only works
 * > when we are 100% sure that chunk corresponds to an item.
 *
 * Two halves, and the second one is only allowed because the first one is honest.
 *
 * **The attribution** is host state, kept *beside* the chunks and never on them — the
 * same rule `utils/chunk-stamps.js` follows, for the same reason: a chunk is the message
 * the provider is sent verbatim, so no bookkeeping field may ride on it. The item in
 * flight is set by `update_task` (`start` opens one, `complete` moves to the next), so a
 * chunk is attributed to the item that was open when it entered the window. Nothing here
 * guesses: a chunk added while no item is open gets `NO_ITEM` and is never collapsed.
 *
 * **The collapse** replaces a maximal run of chunks that all belong to one *completed*
 * item with a single deterministic summary — no model call, so the same window always
 * collapses the same way. It is deliberately timid, because the entry's own caveat is
 * the whole design:
 *
 *  - a run is only ever **contiguous chunks with the same non-null item**, so a chunk
 *    with no attribution breaks it and stays verbatim;
 *  - a run is **skipped, not trimmed**, when collapsing it would cut a tool batch in
 *    half — the same 400 the compaction boundary avoids (`utils/compaction.js`);
 *  - a run of fewer than `minChunks` chunks is left alone, because replacing one chunk
 *    with a summary of it is not a saving;
 *  - a run whose summary would not be **smaller** than the run itself is left alone, so
 *    the collapse can never grow the window;
 *  - the whole window is never collapsed away.
 *
 * Nothing is lost by collapsing: the uncompacted history is the journal
 * (`app/context-window.js#journal`, written to `conversation.json`), so "if it needs
 * anything it can query back again" is a property of the record, not a hope.
 *
 * Pure: no clock, no filesystem, no model, so every rule is provable on arrays.
 */

import { estimateMessagesTokens } from './tokens.js';

/** The attribution of a chunk that belongs to no item: never collapsed. */
export const NO_ITEM = null;

/** Marker prefixed to a collapsed section so it is recognisable in the window. */
export const COLLAPSED_ITEM_PREFIX = '[collapsed item]';

/**
 * Force an attribution list to exactly `length` entries.
 *
 * The same guard `utils/chunk-stamps.js#normalizeStamps` applies, for the same reason:
 * a hand-edited or older record must not shift an attribution onto the wrong row. An
 * entry that is not a non-empty string becomes `NO_ITEM`.
 *
 * @param {any[]} items
 * @param {number} length the chunk count the attributions must match
 * @returns {(string|null)[]}
 */
export function normalizeItems(items = [], length = 0) {
  const size = Math.max(0, Number(length) || 0);
  const list = Array.isArray(items) ? items : [];
  return Array.from({ length: size }, (_, index) => {
    const value = list[index];
    return typeof value === 'string' && value.trim() !== '' ? value : NO_ITEM;
  });
}

/**
 * Rebuild the attributions for a new chunk list from the old one.
 *
 * A chunk that survives a rewrite — the tail a compaction keeps, the user message it
 * carries over — survives **by reference**, so its own attribution is looked up by
 * identity and kept. Anything new (a summary chunk, a collapsed section) gets
 * `fallback`, which is `NO_ITEM` unless the caller knows better: a fresh chunk is not
 * provably part of any item.
 *
 * @param {object} parts
 * @param {any[]} parts.previousChunks
 * @param {any[]} parts.previousItems
 * @param {any[]} parts.nextChunks
 * @param {string|null} [parts.fallback]
 */
export function alignItems({
  previousChunks = [],
  previousItems = [],
  nextChunks = [],
  fallback = NO_ITEM,
} = {}) {
  const known = new Map();
  const attributions = normalizeItems(previousItems, previousChunks.length);
  previousChunks.forEach((chunk, index) => {
    if (chunk && typeof chunk === 'object' && !known.has(chunk)) known.set(chunk, attributions[index]);
  });
  const fresh = typeof fallback === 'string' && fallback.trim() !== '' ? fallback : NO_ITEM;
  return nextChunks.map((chunk) => {
    if (!chunk || typeof chunk !== 'object') return NO_ITEM;
    return known.has(chunk) ? known.get(chunk) : fresh;
  });
}

/** True when a chunk is an assistant message asking for tools. */
export function isToolCallChunk(chunk) {
  return Boolean(
    chunk
    && typeof chunk === 'object'
    && chunk.role === 'assistant'
    && Array.isArray(chunk.tool_calls)
    && chunk.tool_calls.length > 0
  );
}

/** True when a chunk is a result answering a tool call. */
export function isToolResultChunk(chunk) {
  return Boolean(chunk && typeof chunk === 'object' && chunk.role === 'tool');
}

/**
 * The maximal runs of contiguous chunks attributed to one item.
 *
 * A run ends at the first chunk that belongs to a different item or to no item at all,
 * so a gap in the attribution always breaks it. Runs are reported in window order.
 *
 * @param {any[]} chunks
 * @param {(string|null)[]} items
 * @returns {{item: string, start: number, end: number, chunks: any[]}[]} `end` is exclusive
 */
export function findItemRuns(chunks = [], items = []) {
  const list = Array.isArray(chunks) ? chunks : [];
  const attributions = normalizeItems(items, list.length);
  const runs = [];
  let start = 0;

  while (start < list.length) {
    const item = attributions[start];
    if (item === NO_ITEM) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < list.length && attributions[end] === item) end += 1;
    runs.push({ item, start, end, chunks: list.slice(start, end) });
    start = end;
  }

  return runs;
}

/**
 * True when collapsing `chunks.slice(start, end)` would cut a tool batch in half.
 *
 * The same cut the compaction boundary refuses (`utils/compaction.js`): a window whose
 * kept tail begins with a `tool` message, its assistant message summarised away, is
 * refused by the provider with a 400 — and keeps being refused, because the history is
 * carried from call to call. So a run that *begins* with a result whose call sits
 * outside it, or *ends* with a call whose results sit outside it, is not collapsed.
 * Skipping is the safe direction: the chunks stay verbatim.
 */
export function cutsToolBatch(chunks = [], start = 0, end = 0) {
  const list = Array.isArray(chunks) ? chunks : [];
  // Each edge is judged on its own side: a result at the start is only unsafe when
  // its call is *outside* the run (so `start > 0`), and a call at the end is only
  // unsafe when its results are outside it (so `end < list.length`).
  if (start > 0 && isToolResultChunk(list[start])) return true;
  if (end < list.length && isToolCallChunk(list[end - 1])) return true;
  return false;
}

/**
 * The deterministic summary of a collapsed run.
 *
 * Derived from the chunks themselves — the item, how many chunks, how many tool calls
 * and which tools — so the same run always produces the same text and no model is
 * needed. It is a *pointer*, not a retelling: the journal still holds every chunk.
 *
 * @param {{item: string, chunks: any[]}} run
 * @returns {string}
 */
export function summarizeRun(run = {}, { capture = null } = {}) {
  const chunks = Array.isArray(run.chunks) ? run.chunks : [];
  const calls = chunks.flatMap((chunk) => (
    isToolCallChunk(chunk) ? chunk.tool_calls.map((call) => call?.function?.name).filter(Boolean) : []
  ));
  const names = [...new Set(calls)].sort();
  const parts = [
    `${chunks.length} chunk${chunks.length === 1 ? '' : 's'}`,
    calls.length > 0 ? `${calls.length} tool call${calls.length === 1 ? '' : 's'}` : null,
    names.length > 0 ? `via ${names.join(', ')}` : null,
  ].filter(Boolean);
  // The pointer must be *followable*. A capture id names raw chunks kept in the session
  // folder (`docs/context/chunkpaction`), so the model can read them back; without one
  // there is nothing to name, and the summary says only that the section was solved.
  const pointer = capture === null || capture === undefined
    ? 'The raw chunks are kept in this session\'s chunkpaction captures.'
    : `Raw chunks: read_chunkpaction({ capture: ${capture} }).`;
  return `${COLLAPSED_ITEM_PREFIX} "${run.item}" — solved and collapsed (${parts.join('; ')}). ${pointer}`;
}

/** Wrap a collapsed summary so it is recognisable as a collapsed chunk in the window. */
export function buildCollapsedChunk(summary, { item, collapsedChunks = 0, capture = null } = {}) {
  return {
    role: 'system',
    content: String(summary).trim(),
    collapsed: true,
    collapsed_item: item ?? null,
    collapsed_chunks: collapsedChunks,
    // The id a reader follows to get the raw chunks back. `null` when the caller kept
    // none, which is what a collapse with no capture writer produces.
    collapsed_capture: capture ?? null,
  };
}

/**
 * Collapse every completed item's section, deterministically.
 *
 * @param {any[]} chunks the window
 * @param {(string|null)[]} items the parallel attributions
 * @param {object} [options]
 * @param {Iterable<string>} [options.completed] the items known to be done (from `task.md`)
 * @param {number} [options.minChunks] the shortest run worth collapsing
 * @param {Function} [options.estimate] the token estimator, injected so the rule is testable
 * @param {(run: {item: string, chunks: any[]}) => (number|object|null)} [options.writeCapture]
 *   persists a collapsing run and answers its capture id (or `{ capture }`). Injected so
 *   this module stays free of any filesystem: the window supplies the real writer
 *   (`utils/chunkpaction-store.js`), a test supplies a stub, and no writer means the
 *   summary names no id rather than inventing one.
 * @returns {{chunks: any[], items: (string|null)[], collapsed: object[]}} the rewritten
 *   window, its fresh attributions (a collapsed section belongs to no item), and what
 *   was collapsed — `[]` when nothing was, so a caller can tell a no-op from a rewrite
 */
export function collapseCompletedItems(chunks = [], items = [], {
  completed = [],
  minChunks = 2,
  estimate = estimateMessagesTokens,
  writeCapture = null,
} = {}) {
  const list = Array.isArray(chunks) ? chunks : [];
  const attributions = normalizeItems(items, list.length);
  const done = new Set(
    [...(completed ?? [])].filter((value) => typeof value === 'string' && value.trim() !== '')
  );

  const nextChunks = [];
  const nextItems = [];
  const collapsed = [];

  // The window is walked in order, not run by run: a chunk that belongs to no item
  // (or to an item that is not done) is copied through verbatim, so nothing can be
  // dropped from the window by a collapse that never touched it.
  let index = 0;
  while (index < list.length) {
    const item = attributions[index];
    if (item === NO_ITEM) {
      nextChunks.push(list[index]);
      nextItems.push(NO_ITEM);
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < list.length && attributions[end] === item) end += 1;
    const runChunks = list.slice(index, end);

    const worthIt = done.has(item)
      && runChunks.length >= Math.max(2, Number(minChunks) || 2)
      // The whole window is never collapsed away: something has to remain to send.
      && !(index === 0 && end === list.length)
      && !cutsToolBatch(list, index, end);

    if (worthIt) {
      // The capture is written **before** the window is rewritten, and only for a run
      // that really collapses: a writer that throws leaves the window untouched, so a
      // failed capture can never cost the conversation its raw chunks.
      const capture = typeof writeCapture === 'function'
        ? writeCapture({ item, chunks: runChunks })
        : null;
      const captureId = capture && typeof capture === 'object' ? capture.capture : capture;
      const summary = summarizeRun({ item, chunks: runChunks }, { capture: captureId });
      const replacement = buildCollapsedChunk(summary, {
        item,
        collapsedChunks: runChunks.length,
        capture: captureId,
      });
      // A collapse that did not shrink the window is not a collapse: the run stays.
      if (estimate([replacement]) < estimate(runChunks)) {
        nextChunks.push(replacement);
        // A collapsed section is a new chunk and is not provably part of any item.
        nextItems.push(NO_ITEM);
        collapsed.push({ item, start: index, end, chunks: runChunks.length, capture: captureId, summary });
        index = end;
        continue;
      }
    }

    nextChunks.push(...runChunks);
    nextItems.push(...attributions.slice(index, end));
    index = end;
  }

  return { chunks: nextChunks, items: nextItems, collapsed };
}
