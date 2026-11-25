import {
  COMPACTION_OLD_RATIO,
  COMPACTION_KEEP_RATIO,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_UNADDRESSED_PREFIX
} from '../config/constants.js';
import { estimateMessageTokens, estimateMessagesTokens, exceedsTokenBudget } from './tokens.js';
import {
  chunkToText,
  describeCompactionSplit,
  lastUserChunk,
  serializeChunks,
} from './compaction-render.js';

/**
 * Context-window compaction (task.md item 8).
 *
 * The context window is modelled as an ordered array of *chunks* (chat
 * messages). When its token count exceeds CONTEXT_MAX_LENGTH the older share of
 * the window (by token mass) is replaced by a single summarised chunk while the
 * newer share is kept verbatim. Both shares are the configured factors
 * (`config/constants.js#COMPACTION_OLD_RATIO`, overridable through the
 * `COMPACTION_OLD_RATIO` env var), and `describeCompactionSplit()` is the one
 * place every message reads them from, so no figure is repeated in prose.
 *
 * The user's own words are the one thing a summary must never stand in for: the
 * last message the user wrote inside the evicted block is carried over
 * verbatim, right after the summary and ahead of the kept tail
 * (`lastUserChunk`), so the intent survives exactly as it was typed.
 *
 * That carry is **code, not a model answer**: the summariser is never asked to
 * preserve the user's words, so a summary that never mentions them still leaves
 * them in the window. The request is self-contained for the same reason — its own
 * instruction plus the evicted chunks, with the agent system prompt deliberately
 * absent (`systemPrompt: false`) and `config/prompt.md` saying nothing about compaction
 * at all.
 *
 * The split and the assembly are pure functions so they can be unit-tested
 * without a model; only the summary text needs a model call, which is injected
 * as `callModel` to keep this module provider-agnostic.
 *
 * The module is split in two along the same line the rest of the harness uses:
 * this file owns the *decision* (where the window is cut, what becomes the
 * window), and `utils/compaction-render.js` owns the *words* (how a chunk is
 * written for the summariser, how the split is named). The rendering half is
 * re-exported here, because these are the symbols the specs and the call sites
 * name.
 */

export { chunkToText, describeCompactionSplit, lastUserChunk, serializeChunks };

export const SUMMARIZER_SYSTEM_PROMPT = [
  'You are the context-compaction component of a coding agent.',
  'This message is the whole instruction: nothing else is sent with this request, and the payload below is the entire record of the conversation you are summarising.',
  'Produce a brief but thorough summary, in markdown, that a fresh agent could use to continue the work.',
  'Always cover, in this order:',
  '1. Original intent - what the user asked for and the constraints in force.',
  '2. Tasks done - completed work, decisions taken, and how each was verified.',
  '3. Things pending - remaining work, open questions and blockers.',
  '4. Key facts - file paths, commands, tool outputs, identifiers and errors worth remembering.',
  "The harness keeps the user's own last message verbatim outside your summary, so describe that intent in your own words instead of quoting the user back.",
  'Do not add preamble, apologies or meta commentary. Output only the summary.'
].join('\n');

/**
 * The index a split boundary may not fall on.
 *
 * A provider that speaks the OpenAI chat schema pairs every assistant message that
 * carries `tool_calls` with one `tool` message per call id. A window whose kept tail
 * begins with such a `tool` message — its assistant message having been summarised
 * away — is refused with a 400, and keeps being refused because the history is carried
 * from call to call: the session is stuck while a new one works. So the boundary must
 * never land *inside* a batch.
 *
 * There is exactly one unsafe boundary: the one **between an assistant message
 * carrying `tool_calls` and the `tool` messages that answer it**. Everything else is
 * safe, because a batch's results always follow its call.
 *
 * When the boundary lands there, the whole batch is **kept**: the boundary moves up
 * to where the batch starts, so the batch and its results stay together in the kept tail.
 *
 * Keeping the batch (rather than summarising it) is the safe direction: the kept tail
 * is never empty and never starts with a result. Summarising the batch instead would
 * evict the *last* chunk of the window along with it, leaving nothing to send — and a
 * window with nothing in it makes the provider answer a request it cannot answer, over
 * and over. The cost of keeping the batch is that the window may stay over budget for
 * one turn; the cost of the other choice is a session that never works again.
 *
 * @param {any[]} chunks the whole window
 * @param {number} startIndex the boundary the token budget chose
 * @returns {number} the nearest boundary that does not cut a batch
 */
export function alignSplitToToolBatches(chunks = [], startIndex = 0) {
  const list = Array.isArray(chunks) ? chunks : [];
  const index = Math.max(0, Math.min(list.length, Number(startIndex) || 0));
  if (index === 0 || index >= list.length) return index;

  // The chunk just below the boundary is a result whose call is above it.
  if (list[index]?.role === 'tool') {
    // Walk up to the assistant message that owns this result.
    let owner = index - 1;
    while (owner > 0 && list[owner]?.role === 'tool') owner -= 1;
    const call = list[owner];
    if (call?.role === 'assistant' && Array.isArray(call.tool_calls) && call.tool_calls.length > 0) {
      // The batch is cut: it is kept whole, so the boundary moves up to where the
      // batch starts.
      return owner;
    }
  }

  // The chunk just above the boundary is a call whose results are below it: the same
  // cut, seen from the other side.
  const previous = list[index - 1];
  if (previous?.role === 'assistant' && Array.isArray(previous.tool_calls) && previous.tool_calls.length > 0) {
    // The same cut from the other side: the call is kept and so are its results.
    return index;
  }

  return index;
}

/**
 * Split an ordered chunk list into the older block to summarise and the newer
 * block to keep, using token mass rather than chunk count so a couple of huge
 * chunks cannot skew the configured split.
 *
 * The boundary is then moved so it never cuts a tool batch in half
 * (`alignSplitToToolBatches`): a window whose kept tail starts with a `tool` message
 * is refused by the provider with a 400, and keeps being refused, because the history
 * is carried from call to call — the session is stuck while a new one works.
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
  // Never cut a tool batch in half: the boundary moves to the nearest safe one.
  startIndex = alignSplitToToolBatches(chunks, startIndex);

  const older = chunks.slice(0, startIndex);
  const kept = chunks.slice(startIndex);
  // The accounting follows the boundary that was actually used: the alignment may have
  // moved it, and a report that named the old split would be a lie.
  const olderTokens = counts.slice(0, startIndex).reduce((sum, value) => sum + value, 0);
  const keptTokensNow = counts.slice(startIndex).reduce((sum, value) => sum + value, 0);
  return {
    older,
    kept,
    olderTokens,
    keptTokens: keptTokensNow,
    totalTokens,
    oldRatio,
    keepRatio
  };
}

/**
 * The chunkpaction captures a compaction must carry across, in the order they appear.
 *
 * A collapsed summary names `read_chunkpaction({ capture: N })`, and the compaction
 * summariser is a *model*: it paraphrases, so that line is exactly the kind of detail a
 * summary drops. The ids therefore have to be carried by code, like the user's own
 * words (`lastUserChunk`) and for the same reason — a pointer the model cannot see is a
 * pointer it cannot follow.
 *
 * Read from the chunks themselves rather than from a store, so this stays pure and a
 * chunk is the only thing consulted. Duplicates collapse to one entry, because the same
 * capture can be named by a summary that was itself summarised.
 *
 * @param {any[]} chunks
 * @returns {number[]} the capture ids, ascending and deduplicated
 */
export function capturePointers(chunks = []) {
  if (!Array.isArray(chunks)) return [];
  const ids = new Set();
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue;
    // The structured field first: it is what the collapse wrote, so it survives any
    // rendering. The text is the fallback for a chunk written before the field existed.
    const declared = Number(chunk.collapsed_capture);
    if (Number.isInteger(declared) && declared > 0) ids.add(declared);
    if (typeof chunk.content !== 'string') continue;
    for (const match of chunk.content.matchAll(/read_chunkpaction\(\{\s*capture:\s*(\d+)/g)) {
      ids.add(Number(match[1]));
    }
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * The chunk that keeps a capture reachable across a compaction.
 *
 * A **chunk**, not a bare string: everything in the window is an object with a `role` and
 * `content`, and a string pushed among them would be sent as a content-less chunk — the
 * pointer would be there in the array and invisible to the model.
 *
 * `null` when there is nothing to carry, so a compaction with no collapsed section adds
 * no line at all — the same shape the user-message carry has.
 */
export function buildCaptureCarry(captures = []) {
  const ids = (Array.isArray(captures) ? captures : []).filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return null;
  const calls = ids.map((id) => `read_chunkpaction({ capture: ${id} })`).join(', ');
  return {
    role: 'system',
    content: `${COMPACTION_SUMMARY_PREFIX}\nCaptures from collapsed sections are still readable: ${calls}.`,
    capture_carry: ids,
  };
}

/**
 * The newest summary already in the window, or `null` when this is the first compaction.
 *
 * A chunk is a summary when it is marked `compacted` — every compaction writes that field
 * — or, for a chunk restored from a session written before the field existed, when its
 * text carries `COMPACTION_SUMMARY_PREFIX`. Recognising it is what lets the *next*
 * compaction ask a different question: not "summarise this again", but "what did your
 * predecessor promise that nobody has done?"
 *
 * Deliberately one chunk and not a list: only the most recent summary is still the live
 * statement of what is pending. An older one has been superseded, so asking about it
 * again would resurrect work the newest summary already closed.
 *
 * @param {any[]} chunks
 * @returns {any|null}
 */
export function previousSummaryChunk(chunks = []) {
  if (!Array.isArray(chunks)) return null;
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const chunk = chunks[i];
    if (!chunk || typeof chunk !== 'object') continue;
    // A collapsed item's summary shares the prefix family but is not a compaction: it
    // describes work that is *done*, so there is nothing pending to audit in it.
    if (chunk.collapsed === true) continue;
    if (chunk.compacted === true) return chunk;
    if (typeof chunk.content === 'string' && chunk.content.startsWith(COMPACTION_SUMMARY_PREFIX)) return chunk;
  }
  return null;
}

/**
 * The instruction for the one extra request a repeated compaction costs.
 *
 * It is self-contained for the same reason the summariser is: this message names what is
 * being asked and carries the payload, and nothing else rides the request — no agent
 * system prompt, no conversation. The question is narrow on purpose. The summariser's
 * job is to describe work that happened; this call's job is to name work that was
 * promised and did not happen, which is the part a summary of a summary loses first.
 */
export const UNADDRESSED_SYSTEM_PROMPT = [
  'You are the context-compaction component of a coding agent.',
  'An earlier compaction summarised part of this conversation and listed things that were still pending.',
  'This message is the whole instruction: nothing else is sent with this request, and the payload below is the entire record you are given.',
  'Name what the earlier summary left unaddressed: the pending work, open questions and promises that the record shows were not completed or resolved.',
  'Answer with a short markdown list, one item per line, each item traceable to the record.',
  'Only name what is genuinely unaddressed: work that the record shows as completed, verified or withdrawn is not unaddressed.',
  'If the earlier summary left nothing unaddressed, answer exactly with the single word NONE.',
  'Do not add preamble, apologies or meta commentary.'
].join('\n');

/**
 * Build the user message of the unaddressed request.
 *
 * The previous summary comes first because it is the thing being audited, then the record
 * that answers it — the code that does the auditing only has to read one block.
 */
export function buildUnaddressedPrompt(previousSummary, chunks) {
  // The summary is the thing being audited, so it is quoted once at the top; the record
  // below is the rest of the block without it, so the payload carries every byte once.
  const record = (Array.isArray(chunks) ? chunks : []).filter((chunk) => chunk !== previousSummary);
  return [
    'Earlier compaction summary:',
    '',
    chunkToText(previousSummary),
    '',
    `Record that followed it (${record.length} context chunk(s) now being evicted):`,
    '',
    serializeChunks(record)
  ].join('\n');
}

/**
 * The chunk that carries the unaddressed items, or `null` when there are none.
 *
 * `null` for an empty answer, and `null` for the exact word `NONE` — the model is asked
 * for that word so "nothing is pending" is expressible without an empty string, which is
 * also what an empty or broken answer looks like. Carrying a chunk that says nothing would
 * still cost its tokens in every request until the next compaction, and this chunk exists
 * to save them.
 *
 * It is a **chunk**, not a string, for the reason the capture carry is: everything in the
 * window is an object with a `role` and `content`, so a bare string would sit in the array
 * and be invisible to the model.
 */
export function buildUnaddressedChunk(answer, { prefix = COMPACTION_UNADDRESSED_PREFIX } = {}) {
  const text = String(answer ?? '').trim();
  if (!text) return null;
  if (text.toUpperCase() === 'NONE') return null;
  return {
    role: 'system',
    content: `${prefix}\n${text}`,
    unaddressed: true
  };
}

/** Build the user message handed to the summariser model. */
export function buildSummaryPrompt(chunks) {
  return [
    `Compaction request: summarise the ${chunks.length} context chunk(s) below, which are about to be evicted from the window.`,
    'Everything you need is below; nothing else is sent with this request.',
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
 * Compact a chunk list: summarise the older block and prepend it to the kept
 * block, with the last user message of the evicted block carried verbatim
 * between them.
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

  // A collapsed section's summary named a capture id, and the summariser may well have
  // paraphrased that line away. The carry is code, not a model answer, so the pointer
  // survives regardless — without it a compaction would quietly orphan every capture
  // the conversation had kept (`docs/context/chunkpaction`).
  const carry = buildCaptureCarry(capturePointers(split.older));

  // What an *earlier* summary left unaddressed is the first thing a summary of a
  // summary loses: the newest summary describes the work, and the older one's pending
  // list is not work that happened. So when the evicted block holds a summary, one extra
  // self-contained request asks what that summary promised and the record shows undone,
  // and its answer rides ahead of the newest summary in the window.
  //
  // The request is only made when there *is* a previous summary — a first compaction has
  // nothing to audit and must not pay for a second model call. A throwing or empty answer
  // is not fatal either: the compaction still happens, in today's shape, because losing
  // the audit is cheaper than losing the compaction.
  const previousSummary = previousSummaryChunk(split.older);
  let unaddressedChunk = null;
  let unaddressedAsked = false;
  if (previousSummary) {
    const unaddressedMessages = [
      { role: 'system', content: UNADDRESSED_SYSTEM_PROMPT },
      { role: 'user', content: buildUnaddressedPrompt(previousSummary, split.older) }
    ];
    try {
      const answer = await callModel(unaddressedMessages, { signal, purpose: 'context-compaction-unaddressed' });
      unaddressedAsked = true;
      unaddressedChunk = buildUnaddressedChunk(answer);
    } catch {
      // The audit is best-effort; the compaction is not.
      unaddressedAsked = false;
    }
  }

  // The user's own message survives the eviction: the last one they wrote inside
  // the summarised block is re-inserted verbatim, after the summary and ahead of
  // the untouched tail. The summariser saw it too — the summary paraphrases it,
  // this keeps it as written.
  const carried = lastUserChunk(split.older);
  const head = [
    ...(unaddressedChunk ? [unaddressedChunk] : []),
    summaryChunk,
    ...(carry ? [carry] : [])
  ];
  const withCarry = carried ? [...head, carried, ...split.kept] : null;
  // A carry is a fidelity rule, never a licence to grow the window: if it did not
  // still shrink the window, the summary stands alone. The capture line and the
  // unaddressed line are *not* dropped that way — they are small, and losing either
  // costs more than the tokens it holds.
  const carryFits = withCarry !== null && estimateMessagesTokens(withCarry) < split.totalTokens;
  const withHead = carryFits ? withCarry : [...head, ...split.kept];
  // The audit answered something, and in a window where the user's message was most of
  // the evicted block it may be the only reason the window cannot shrink. Then it goes
  // rather than the compaction: the order is summary first, audit second.
  const shrinkFits = estimateMessagesTokens(withHead) < split.totalTokens;
  const nextChunks = shrinkFits ? withHead : [...head.filter((chunk) => chunk !== unaddressedChunk), ...split.kept];
  const keptUnaddressed = Boolean(unaddressedChunk) && shrinkFits;
  const afterTokens = estimateMessagesTokens(nextChunks);

  return {
    chunks: nextChunks,
    summary: `<compaction-result>\n${summary}\n</compaction-result>`,
    compacted: true,
    stats: {
      ...stats,
      afterTokens,
      carriedChunks: carryFits ? 1 : 0,
      capturedIds: carry ? capturePointers(split.older) : [],
      previousSummary: Boolean(previousSummary),
      unaddressedAsked,
      unaddressedChunks: keptUnaddressed ? 1 : 0
    }
  };
}

/** True when the chunk list no longer fits the configured budget. */
export function needsCompaction(chunks, maxTokens, tools = []) {
  return exceedsTokenBudget(chunks, maxTokens, tools);
}
