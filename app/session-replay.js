import { formatUserEcho } from './tui-render.js';
import {
  formatCallLines,
  formatToolHeader,
  normalizeToolCalls,
  parseToolChunk,
} from './tool-call-format.js';

/**
 * Reload a stored conversation into the transcript.
 *
 * A session file holds every chunk verbatim (`docs/runtime/session-store`), but
 * resuming it only restored the *context window*: the model remembered the
 * conversation while the transcript showed nothing. This module turns the chunks
 * back into the display the live loop produced for them, so opening a session
 * shows the conversation as it was left.
 *
 * Pure: it returns *render operations*, not printed lines, so the same replay
 * drives the TUI (collapsible blocks) and the line CLI (plain lines) and can be
 * unit tested without a terminal. Nothing here touches the model or the chunks:
 * replay is presentation only.
 *
 * The shapes it reuses — the `You:` echo, the `-> Calling …`/`intent:` lines, the
 * `[<tool> Output]` header, the body of a tool chunk — all come from the modules
 * the live loop uses, so a resumed conversation cannot drift from the one that
 * produced it (`app/tool-call-format.js`, `app/tui-render.js`).
 */

/** The delimiters the live loop prints around a final assistant reply. */
export const REPLAY_REPLY_HEADER = '--- AI Response ---';
export const REPLAY_REPLY_FOOTER = '----------------------';

/** Label used for a tool chunk whose call is not in the session. */
export const UNKNOWN_TOOL_NAME = 'tool';

/** The notice that stands in for a chunk the compaction replaced. */
export function formatCompactedNotice(chunk) {
  const count = Number(chunk?.summarized_chunks) || 0;
  const detail = count > 0 ? `${count} chunk(s) summarised` : 'earlier context';
  return `[Context] earlier context was compacted into a summary (${detail}).`;
}

/** Index the `tool` chunks by the call id they answer, preserving their order. */
function indexToolChunks(chunks) {
  const byId = new Map();
  for (const chunk of chunks) {
    if (chunk?.role !== 'tool') continue;
    const id = String(chunk.tool_call_id ?? '');
    const queue = byId.get(id) || [];
    queue.push(chunk);
    byId.set(id, queue);
  }
  return byId;
}

/** One `{ kind: 'log' | 'block' }` display operation. */
const logOp = (text) => ({ kind: 'log', text: String(text ?? '') });
const blockOp = (header, body) => ({ kind: 'block', header, body: String(body ?? '') });

/**
 * Turn a stored chunk list into the display operations that reproduce it.
 *
 * @returns {{ops: object[], calls: number, blocks: number, notices: number, skipped: number}}
 */
export function replayChunks(chunks = []) {
  const list = Array.isArray(chunks) ? chunks : [];
  const toolsById = indexToolChunks(list);
  const cursors = new Map();
  const consumed = new Set();
  const ops = [];
  let calls = 0;
  let blocks = 0;
  let notices = 0;
  let skipped = 0;

  /** The first not-yet-claimed tool chunk answering `id`, or null. */
  const claimTool = (id) => {
    const key = String(id ?? '');
    const queue = toolsById.get(key);
    if (!queue) return null;
    const cursor = cursors.get(key) || 0;
    if (cursor >= queue.length) return null;
    cursors.set(key, cursor + 1);
    consumed.add(queue[cursor]);
    return queue[cursor];
  };

  /** A tool chunk as a collapsible block, its intent and error marker unwrapped. */
  const pushBlock = (chunk, toolName) => {
    const parsed = parseToolChunk(chunk.content);
    ops.push(blockOp(formatToolHeader(toolName, parsed.intent), parsed.body));
    blocks += 1;
  };

  for (const chunk of list) {
    const role = chunk?.role;

    if (role === 'user') {
      ops.push(logOp(formatUserEcho(chunk.content ?? '')));
      continue;
    }

    if (role === 'assistant') {
      const toolCalls = normalizeToolCalls(chunk);
      if (toolCalls.length === 0) {
        const content = chunk.content;
        if (content === undefined || content === null || `${content}`.trim() === '') {
          skipped += 1;
          continue;
        }
        // The live loop brackets the reply, so the replay does too: it is what
        // was on screen. The per-turn `[Context] <usage>` line that followed is
        // not reproduced — it reported the live window at that moment.
        ops.push(logOp(`${REPLAY_REPLY_HEADER}\n${content}\n${REPLAY_REPLY_FOOTER}`));
        continue;
      }
      // An assistant chunk may carry prose next to its calls; it is printed as
      // prose (the reply delimiters belong to a tool-free final answer).
      if (chunk.content != null && `${chunk.content}`.trim() !== '') {
        ops.push(logOp(chunk.content));
      }
      for (const call of toolCalls) {
        // Interleaved exactly as the live loop printed it: the call, then the
        // result the hook echoed while the tool ran.
        for (const text of formatCallLines(call)) ops.push(logOp(text));
        calls += 1;
        const answered = claimTool(call.id);
        if (answered) pushBlock(answered, call.name);
      }
      continue;
    }

    if (role === 'tool') {
      if (consumed.has(chunk)) continue;
      // No recorded call for this result (a truncated session, a hand-edited
      // file): it still renders rather than throwing.
      pushBlock(chunk, UNKNOWN_TOOL_NAME);
      continue;
    }

    if (role === 'system') {
      if (chunk.compacted === true) {
        ops.push(logOp(formatCompactedNotice(chunk)));
        notices += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    skipped += 1;
  }

  return { ops, calls, blocks, notices, skipped };
}

/**
 * Drive a front end with replay operations.
 *
 * `log(text)` prints one display entry; `logBlock({ header, body })` prints a
 * collapsible block. Without `logBlock` (the line CLI has no widget) a block is
 * printed as its header, its body and a blank line — the same shape `main.js`
 * uses for a live tool result.
 */
export function renderReplay(ops = [], { log, logBlock } = {}) {
  if (typeof log !== 'function') return 0;
  let rendered = 0;

  for (const op of ops) {
    if (op?.kind === 'block') {
      if (typeof logBlock === 'function') logBlock({ header: op.header, body: op.body });
      else {
        log(op.header);
        log(op.body);
        log('');
      }
    } else {
      log(op?.text ?? '');
    }
    rendered += 1;
  }

  return rendered;
}

/**
 * Reload a stored conversation into a front end in one step: empty the view when
 * it can be emptied (`clear`), then drive it with the replay.
 *
 * Both front ends go through here, so opening a session looks the same in the TUI
 * and in the line CLI; only the block rendering differs.
 *
 * @returns {object} the replay report (see replayChunks)
 */
export function reloadConversation(chunks = [], { log, logBlock, clear } = {}) {
  const replay = replayChunks(chunks);
  if (typeof clear === 'function') clear();
  renderReplay(replay.ops, { log, logBlock });
  return replay;
}
