import { callOllama } from '../api/ollama.js';
import { CONTEXT_MAX_LENGTH } from '../config/constants.js';
import { ContextWindow } from './context-window.js';
import { registerContextWindow } from '../utils/host.js';
import { createUsageMeter, recordProviderCall } from '../utils/usage-stats.js';
import { estimateMessagesTokens } from '../utils/tokens.js';
import { formatArgs as summarizeArgs } from './tool-call-format.js';
import { handleToolBatch } from './tool-batch.js';

/**
 * The conversation loop.
 *
 * The context is an array of chunks (see app/context-window.js) rather than the
 * historical `messages` array, so task.md item 3 (token count of the window) and
 * item 8 (compaction at CONTEXT_MAX_LENGTH) are backed by real state instead of
 * ad-hoc bookkeeping. `getMessages()`/`reset()` remain as compatibility shims.
 *
 * Task.md item 6 is enforced here too: every tool call's `intent` is printed to
 * the terminal *and* persisted in the chunk that carries the tool result, so the
 * reason for a call is both visible to the user and part of the model context.
 *
 * The tool calls of one message are a *batch*: `handleToolCalls` delegates to
 * `app/tool-batch.js`, which caps the batch at `MAX_PARALLEL_TOOL_CALLS`, runs the
 * accepted calls simultaneously and stores one chunk per call in call order
 * (`docs/agent/tool-multicall`).
 */
export class ConversationManager {
  constructor(toolFunctions, getTools, getAbortSignal = () => null, options = {}) {
    this.toolFunctions = toolFunctions;
    this.getTools = getTools; // Function that returns current tools array
    this.getAbortSignal = getAbortSignal; // Function that returns the active task's AbortSignal
    this.log = options.log || ((message) => console.log(message));
    this.onContextChange = options.onContextChange || null;
    // The user's own message is announced before the model is called, so both
    // front ends can echo it: the transcript is otherwise one-sided.
    this.onUserMessage = options.onUserMessage || null;
    // Which model answered: the key the usage table is kept under.
    this.model = options.model || null;
    // Token accounting per model (utils/usage-stats.js).
    this.usage = createUsageMeter({ models: options.usage || {} });
    // How many tool calls of one assistant message run at once.
    this.maxParallelToolCalls = options.maxParallelToolCalls ?? null;

    this.contextWindow = options.contextWindow || new ContextWindow({
      maxTokens: options.maxTokens || CONTEXT_MAX_LENGTH,
      configuredTokens: options.configuredTokens ?? null,
      realTokens: options.realTokens ?? null,
      source: options.contextSizeSource,
      tools: () => this.getTools()
    });
    // Expose the live window to stateless tools (compact_context).
    registerContextWindow(this.contextWindow);
  }

  /** Ordered array of context chunks (task.md items 3 & 8). */
  get chunks() {
    return this.contextWindow.chunks;
  }

  /** The per-model token table (a snapshot), for storage and `/usage`. */
  usageTable() {
    return this.usage.table();
  }

  /**
   * Count one finished provider call against the model that answered it.
   *
   * The context window says how full the request is; this is the accounting
   * record the session keeps (`utils/usage-stats.js`). The provider's own
   * counters are used when it reports them, and the measured prompt plus the
   * answered text are the fallback — flagged as an estimate, never passed off as
   * exact.
   */
  recordUsage(response, promptTokens = 0) {
    return recordProviderCall(this.usage, this.model, { response, promptTokens });
  }

  /**
   * Announce the window's current stats to the host.
   *
   * The token meter is a *view* of the window, so it must follow every change to
   * it instead of being repainted once per turn by the host loop: the user has to
   * see a turn approach the budget while it is still running. Every mutation of
   * the window and every provider call goes through this one helper, so no call
   * site can forget the hook.
   *
   * The hook is presentation only — a listener that throws must never cost the
   * user their turn, exactly like `onUserMessage`.
   */
  notifyContextChange() {
    if (!this.onContextChange) return null;
    const stats = this.contextWindow.stats();
    try {
      this.onContextChange(stats);
    } catch {
      // display only: a broken meter must not break the conversation
    }
    return stats;
  }

  /**
   * Creates a simple string representation of the function arguments.
   * - If the argument is a short string, number, or boolean (length <= 20),
   *   it shows "paramName: value".
   * - If the argument is a long string (length > 20),
   *   it shows "paramName: string(Nchars)".
   * - Otherwise, it shows "paramName: [object Object]" or similar.
   */
  formatArgs(args) {
    // The call's shape lives in ./tool-call-format.js, so the session replay
    // prints the very same summary when it reloads a conversation.
    return summarizeArgs(args);
  }

  async processInput(userInput) {
    this.contextWindow.add({ role: "user", content: userInput });
    // The chunk is what the model receives, verbatim; the hook is presentation
    // only (app/tui-render.js#formatUserEcho renders it), and a hook that throws
    // must never cost the user their prompt.
    if (this.onUserMessage) {
      try { this.onUserMessage(userInput); } catch { /* display only */ }
    }
    // The prompt is a chunk too, so the meter moves before the first call is
    // even sent instead of once the whole turn is over.
    this.notifyContextChange();

    while (true) {
      const signal = this.getAbortSignal();

      // Task.md item 8: never call the model with an over-budget window.
      await this.maybeCompact(signal);

      // Everything the window holds at this instant is about to be sent, so
      // paint exactly that: the meter is current for the call that can still be
      // rejected for being over budget.
      this.notifyContextChange();

      try {
        // What the request is about to cost, measured before it is sent: used
        // only when the provider answers without counters of its own.
        const promptTokens = this.contextWindow.estimatedTokens();
        const data = await callOllama(this.contextWindow.chunks, this.getTools(), false, signal);

        // Treat null or empty response as an error and retry
        if (!data || !data.message) {
          this.log("\nError: Received null/empty API response. Retrying...");
          continue;
        }
        this.recordUsage(data, promptTokens);

        if (data.message.tool_calls) {
          const wantsCompaction = await this.handleToolCalls(data.message.tool_calls, signal);
          if (wantsCompaction) await this.maybeCompact(signal, { force: true, reason: 'tool-request' });
        } else {
          const content = data.message.content;
          await this.handleFinalResponse(content !== undefined && content !== null ? content : "");
          break;
        }
      } catch (error) {
        if (error.name === 'AbortError' || error.message?.toLowerCase().includes('aborted')) {
          this.log("\n[Info] Request aborted; stopping this task.");
          break;
        }
        this.log(`\nError calling Ollama: ${error.message}`);
        break;
      }
    }
  }

  /**
   * Compact the window when it exceeds CONTEXT_MAX_LENGTH (or when forced).
   * The summary call deliberately opts out of the agent system prompt.
   */
  async maybeCompact(signal, { force = false, reason = 'over-budget' } = {}) {
    if (!force && !this.contextWindow.needsCompaction()) return null;

    try {
      const result = await this.contextWindow.compact({
        force,
        reason,
        signal,
        // callOllama resolves to the normalised response object, so unwrap the
        // summary text before handing it to the compactor.
        callModel: async (messages, ctx) => {
          const promptTokens = estimateMessagesTokens(messages);
          const response = await callOllama(messages, [], false, ctx.signal, { systemPrompt: false });
          // The summariser is a provider call like any other: it is billed, so it
          // is counted against the same model.
          this.recordUsage(response, promptTokens);
          return response?.message?.content ?? '';
        }
      });

      if (result.compacted) {
        this.log(`\n[Context] Compacted ${result.olderChunks} older chunk(s) into a summary (${result.olderTokens} -> ${result.afterTokens} tokens).`);
        this.log(`[Context] Window: ${result.usage}`);
        // The window was rewritten underneath the chunks, so the meter has to
        // be repainted with the smaller number straight away.
        this.notifyContextChange();
      }
      return result;
    } catch (error) {
      // A failed compaction must never break the task; the window is unchanged.
      this.log(`\n[Context] Compaction skipped: ${error.message}`);
      return { compacted: false, reason: 'error', error: error.message };
    }
  }

  /**
   * Run the tool calls of one assistant message as a batch.
   *
   * The batch itself lives in `app/tool-batch.js`: the accepted calls are capped
   * at `MAX_PARALLEL_TOOL_CALLS`, dispatched simultaneously, and stored one chunk
   * per call in call order — each result inside the `<tool-multicall result>`
   * envelope that carries the call's signature (`docs/agent/tool-multicall`).
   * Passing the window, the log and the tool map in keeps this method the wiring
   * only, and keeps the batch unit testable without a provider.
   *
   * @returns {Promise<boolean>} true when a tool asked for a deferred compaction.
   */
  async handleToolCalls(toolCalls, signal) {
    const report = await handleToolBatch({
      toolCalls,
      signal,
      window: this.contextWindow,
      toolFunctions: this.toolFunctions,
      log: (line) => this.log(line),
      notify: () => this.notifyContextChange(),
      ...(this.maxParallelToolCalls ? { max: this.maxParallelToolCalls } : {}),
    });
    this.lastBatch = report;
    return report.compactionRequested;
  }

  async handleFinalResponse(content) {
    this.contextWindow.add({ role: "assistant", content });
    this.notifyContextChange();

    this.log("\n--- AI Response ---");
    this.log(content);
    this.log("----------------------");
    this.log(`[Context] ${this.contextWindow.usage()}\n`);
  }

  /** Compatibility shim: the context window as a plain message array. */
  getMessages() {
    return this.contextWindow.chunks;
  }

  reset() {
    this.contextWindow.clear();
  }
}

// The marker itself lives in ./compaction-request.js (a pure string check);
// re-exported here because this is the module the loop and the docs name.
export { detectCompactionRequest } from './compaction-request.js';
