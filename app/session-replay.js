import { formatUserEcho } from './tui-render.js';
import { formatStampAt, dayDividerFor, stampDay } from '../utils/session-time.js';
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

/**
 * A mark rides on an op only when there is one, so a record stored before the marks
 * existed replays to exactly the ops it always did (`docs/interface/session-stamps`).
 */
const withStamp = (op, stamp) => (stamp ? { ...op, stamp } : op);

const logOp = (text, stamp = null) => withStamp({ kind: 'log', text: String(text ?? '') }, stamp);

const proseOp = (role, text, stamp = null) => withStamp({
  kind: 'prose', role, text: String(text ?? ''),
}, stamp);

const blockOp = (header, body, stamp = null) => withStamp({
  kind: 'block', header, body: String(body ?? ''),
}, stamp);

/**
 * Turn a stored chunk list into the display operations that reproduce it.
 *
 * `stamps` are the append times the record kept beside the same chunks
 * (`utils/chunk-stamps.js`): entry `i` is when chunk `i` was written, or `null` for a
 * record that predates them. They ride on the ops rather than inside a row's text — the
 * mark is added by the front end that paints it — and the first entry of each calendar
 * day is preceded by a day divider, so a conversation that spans midnight is not
 * replayed as if every row happened at the same hour.
 *
 * @param {any[]} chunks the stored conversation, verbatim
 * @param {object} [options]
 * @param {(string|null)[]} [options.stamps] index-aligned append times
 * @returns {{ops: object[], calls: number, blocks: number, notices: number, skipped: number}}
 */
export function replayChunks(chunks = [], { stamps = [] } = {}) {
  const list = Array.isArray(chunks) ? chunks : [];
  const marks = Array.isArray(stamps) ? stamps : [];
  const toolsById = indexToolChunks(list);
  const cursors = new Map();
  const consumed = new Set();
  const ops = [];
  let calls = 0;
  let blocks = 0;
  let notices = 0;
  let skipped = 0;
  let day = '';

  /**
   * The mark one stored entry shows, and the divider owed before it when the day
   * changed: the first row of each day opens that day.
   */
  const markOf = (index) => {
    const at = marks[index] ?? null;
    const stamp = formatStampAt(at);
    if (!stamp) return { stamp: null, divider: '' };
    const next = stampDay(at);
    const divider = next && next !== day ? dayDividerFor(next) : '';
    if (divider) day = next;
    return { stamp, divider };
  };

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

  /** The index the offsets are measured from, so a mark answers for its own chunk. */
  const indexOfChunk = new Map();
  list.forEach((chunk, index) => {
    if (chunk && typeof chunk === 'object' && !indexOfChunk.has(chunk)) {
      indexOfChunk.set(chunk, index);
    }
  });
  const markOfChunk = (chunk) => markOf(indexOfChunk.get(chunk) ?? -1);

  const pushDivider = (divider) => {
    if (divider) ops.push(logOp(divider));
  };

  /** A tool chunk as a collapsible block, its intent and error marker unwrapped. */
  const pushBlock = (chunk, toolName) => {
    const parsed = parseToolChunk(chunk.content);
    const mark = markOfChunk(chunk);
    pushDivider(mark.divider);
    // The chunk's `[error]` prefix is the failure the ✓/✗ marker reports, so a resumed
    // conversation marks a row exactly as the live one did.
    const header = formatToolHeader(toolName, parsed.intent, { failed: parsed.isError });
    ops.push(blockOp(header, parsed.body, mark.stamp));
    blocks += 1;
  };

  list.forEach((chunk, index) => {
    const role = chunk?.role;

    if (role === 'user') {
      const mark = markOf(index);
      pushDivider(mark.divider);
      ops.push(proseOp('user', formatUserEcho(chunk.content ?? ''), mark.stamp));
      return;
    }

    if (role === 'assistant') {
      const toolCalls = normalizeToolCalls(chunk);
      if (toolCalls.length === 0) {
        const content = chunk.content;
        if (content === undefined || content === null || `${content}`.trim() === '') {
          skipped += 1;
          return;
        }
        // The live loop brackets the reply, so the replay does too: it is what was on
        // screen. The delimiters are chrome and the reply between them is one side of
        // the dialogue, so the ops mirror the live log exactly — header, prose, footer.
        // The per-turn `[Context] <usage>` line that followed is not reproduced: it
        // reported the live window at that moment. Only the prose carries the mark: the
        // delimiters are the frame, not an entry of their own.
        const mark = markOf(index);
        pushDivider(mark.divider);
        ops.push(logOp(REPLAY_REPLY_HEADER));
        ops.push(proseOp('assistant', content, mark.stamp));
        ops.push(logOp(REPLAY_REPLY_FOOTER));
        return;
      }
      // An assistant chunk may carry prose next to its calls; it is printed as
      // prose (the reply delimiters belong to a tool-free final answer).
      if (chunk.content != null && `${chunk.content}`.trim() !== '') {
        const mark = markOf(index);
        pushDivider(mark.divider);
        ops.push(proseOp('assistant', chunk.content, mark.stamp));
      }
      for (const call of toolCalls) {
        // Interleaved exactly as the live loop printed it: the call, then the
        // result the hook echoed while the tool ran.
        for (const text of formatCallLines(call)) ops.push(logOp(text));
        calls += 1;
        const answered = claimTool(call.id);
        if (answered) pushBlock(answered, call.name);
      }
      return;
    }

    if (role === 'tool') {
      if (consumed.has(chunk)) return;
      // No recorded call for this result (a truncated session, a hand-edited
      // file): it still renders rather than throwing.
      pushBlock(chunk, UNKNOWN_TOOL_NAME);
      return;
    }

    if (role === 'system') {
      if (chunk.compacted === true) {
        const mark = markOf(index);
        pushDivider(mark.divider);
        ops.push(logOp(formatCompactedNotice(chunk), mark.stamp));
        notices += 1;
      } else {
        skipped += 1;
      }
      return;
    }

    skipped += 1;
  });

  return { ops, calls, blocks, notices, skipped };
}

/**
 * Drive a front end with replay operations.
 *
 * `log(text)` prints one display entry; `logProse(role, text, { stamp })` prints one side
 * of the dialogue (banded by a front end that bands); `logBlock({ header, body, stamp })`
 * prints a collapsible block. Without `logBlock` (the line CLI has no widget) a block is
 * printed as its header, its body and a blank line — the same shape `main.js` uses for a
 * live tool result — and without `logProse` a prose op is a plain line, so a front end
 * that bands nothing behaves exactly as before.
 *
 * An op's mark is handed to the route that paints its row, never prepended here: only a
 * front end that marks its own entries can show it, and a front end that does not stays
 * byte-for-byte what it was.
 */
export function renderReplay(ops = [], { log, logProse, logBlock } = {}) {
  if (typeof log !== 'function') return 0;
  let rendered = 0;

  for (const op of ops) {
    const stamp = op?.stamp ?? null;
    if (op?.kind === 'block') {
      if (typeof logBlock === 'function') logBlock({ header: op.header, body: op.body, stamp });
      else {
        log(op.header);
        log(op.body);
        log('');
      }
    } else if (op?.kind === 'prose') {
      if (typeof logProse === 'function') logProse(op.role, op.text, { stamp });
      else log(op.text ?? '');
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
 * `bulk` (optional) wraps the whole replay in a front end's suspension, so a front end
 * that repaints per append (the TUI) pays for one repaint instead of one per entry
 * (`docs/interface/session-replay`). A front end without one — the line CLI prints
 * as it goes — is unchanged.
 *
 * @returns {object} the replay report (see replayChunks)
 */
export function reloadConversation(chunks = [], { log, logProse, logBlock, clear, bulk, stamps = [] } = {}) {
  const replay = replayChunks(chunks, { stamps });
  if (typeof clear === 'function') clear();
  const drive = () => renderReplay(replay.ops, { log, logProse, logBlock });
  if (typeof bulk === 'function') bulk(drive);
  else drive();
  return replay;
}