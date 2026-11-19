import { callOllama } from '../api/ollama.js';
import { CONTEXT_MAX_LENGTH } from '../config/constants.js';
import { ContextWindow } from './context-window.js';
import { registerContextWindow, registerTaskPulse } from '../utils/host.js';
import { createTaskPulse, formatPulseLimitNotice } from '../utils/task-pulse.js';
import { createUsageMeter, recordProviderCall } from '../utils/usage-stats.js';
import { handleToolBatch } from './tool-batch.js';
import { createCompactionRunner, createSummaryCallModel } from './compaction-runner.js';
import { formatRetryNotice, formatFailureNotice } from './notice-overlay.js';

/**
 * The conversation loop.
 *
 * The context is an array of chunks (app/context-window.js), so the token count of
 * the window and its compaction at CONTEXT_MAX_LENGTH are backed by real state;
 * `getMessages()`/`reset()` remain as compatibility shims. Four responsibilities
 * live here, each documented where it is used:
 *
 *  - the tool-call `intent` is printed *and* persisted in the result chunk, so the
 *    reason for a call is both visible and part of the model's context;
 *  - a failure is told apart by whether it was *recovered*: a retried attempt is a
 *    transient notice (app/notice-overlay.js) while the one that ends the task also
 *    keeps a transcript line;
 *  - one assistant message's tool calls are a batch (app/tool-batch.js): capped,
 *    dispatched simultaneously, one chunk per call in call order;
 *  - every agent call carries the model-call pulse (`docs/context/call-pulse`),
 *    generated per call, never stored as a chunk.
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
    // Transient notices (app/notice-overlay.js): a recovered failure is shown in
    // the overlay and expires, instead of staying in the transcript forever.
    this.onNotice = options.onNotice || null;
    // Which model answered: the key the usage table is kept under.
    this.model = options.model || null;
    // Token accounting per model (utils/usage-stats.js).
    this.usage = createUsageMeter({ models: options.usage || {} });
    // How many tool calls of one assistant message run at once.
    this.maxParallelToolCalls = options.maxParallelToolCalls ?? null;
    // The model-call pulse (utils/task-pulse.js): an injected counter keeps the
    // tests deterministic, and it is the object `update_task` resets through the
    // host registry.
    this.pulse = options.pulse || createTaskPulse(options.pulseLimit ? { limit: options.pulseLimit } : {});

    this.contextWindow = options.contextWindow || new ContextWindow({
      maxTokens: options.maxTokens || CONTEXT_MAX_LENGTH,
      configuredTokens: options.configuredTokens ?? null,
      realTokens: options.realTokens ?? null,
      source: options.contextSizeSource,
      tools: () => this.getTools()
    });
    // Expose the live window and the live pulse to stateless tools
    // (compact_context, update_task).
    registerContextWindow(this.contextWindow);
    registerTaskPulse(this.pulse);
    this.compactionRunner = createCompactionRunner({
      window: this.contextWindow,
      log: (line) => this.log(line),
      notify: () => this.notifyContextChange(),
      callModel: createSummaryCallModel({ meter: (response, promptTokens) => this.recordUsage(response, promptTokens) }),
    });
  }

  /** Ordered array of context chunks (task.md items 3 & 8). */
  get chunks() {
    return this.contextWindow.chunks;
  }

  /** The per-model token table (a snapshot), for storage and `/usage`. */
  usageTable() {
    return this.usage.table();
  }

  /** The pulse's view for the host: count, limit and remaining calls. */
  pulseStats() {
    return this.pulse.stats();
  }

  /**
   * Count one finished provider call against the model that answered it.
   *
   * The context window says how full the request is; this is the accounting record
   * the session keeps (`utils/usage-stats.js`). The provider's own counters are
   * used when it reports them, and the measured prompt plus answered text are the
   * fallback — flagged as an estimate, never passed off as exact.
   */
  recordUsage(response, promptTokens = 0) {
    return recordProviderCall(this.usage, this.model, { response, promptTokens });
  }

  /**
   * Announce the window's current stats to the host.
   *
   * The token meter is a *view* of the window, so it must follow every change to it
   * instead of being repainted once per turn by the host loop: the user has to see a
   * turn approach the budget while it is still running. Presentation only — a
   * listener that throws must never cost the user their turn.
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
   * Show a transient notice: the overlay's business, never the transcript's.
   *
   * Presentation only, exactly like `onUserMessage` and `onContextChange`: a hook
   * that throws must never cost the user their turn. Without a hook the message is
   * dropped rather than written to the transcript, because that is the bug this
   * hook exists to fix.
   */
  notifyNotice(kind, text, options = {}) {
    if (!this.onNotice) return null;
    try {
      return this.onNotice(kind, text, options);
    } catch {
      return null;
    }
  }

  /** Report one retried attempt (the `onRetry` hook of api/ollama.js). */
  notifyRetry(report = {}) {
    return this.notifyNotice('warn', formatRetryNotice(report), { code: 'retry' });
  }

  /**
   * One agent model call: count it for the pulse, and raise the single notice that
   * says the hard limit has been passed. The call is *counted*, never refused — the
   * only way the model can reset the pulse is by calling a tool, so refusing the
   * call would deadlock the turn (`docs/context/call-pulse`).
   *
   * @returns {object[]} the call's prelude messages (the pulse line)
   */
  beginModelCall() {
    const state = this.pulse.tick();
    if (state.crossed) {
      this.notifyNotice('warn', formatPulseLimitNotice(state), { code: 'pulse-limit' });
    }
    return [this.pulse.message()];
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

      // Task.md item 8: never call the model with an over-budget window. A
      // compaction rewrote the window, so the pulse starts again from 0.
      const compaction = await this.maybeCompact(signal);
      if (compaction?.compacted) this.resetPulse('compaction');

      // Everything the window holds at this instant is about to be sent, so paint
      // exactly that: the meter is current for the call that is sent next.
      this.notifyContextChange();

      try {
        // Count the call about to be sent, and take the line it carries.
        const prelude = this.beginModelCall();
        // What the request is about to cost, measured before it is sent: used
        // only when the provider answers without counters of its own.
        const promptTokens = this.contextWindow.estimatedTokensWith(prelude);
        const data = await callOllama(this.contextWindow.request(prelude), this.getTools(), false, signal, {
          // A retried attempt is a transient notice, not a transcript line.
          onRetry: (report) => this.notifyRetry(report),
        });

        // Treat null or empty response as an error and retry
        if (!data || !data.message) {
          // Transient too: the loop retries it, so it must not outlive the retry.
          this.notifyNotice('warn', 'Provider answered with an empty response. Retrying…', { code: 'empty-response' });
          continue;
        }
        this.recordUsage(data, promptTokens);

        if (data.message.tool_calls) {
          const wantsCompaction = await this.handleToolCalls(data.message.tool_calls, signal);
          if (wantsCompaction) {
            const forced = await this.maybeCompact(signal, { force: true, reason: 'tool-request' });
            if (forced?.compacted) this.resetPulse('compaction');
          }
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
        // Nothing recovered from this one: it ends the task, so it keeps its
        // transcript line *and* is raised as a notice while the turn winds down.
        this.notifyNotice('error', formatFailureNotice(error), { code: 'provider-failure' });
        this.log(`\nError calling Ollama: ${error.message}`);
        break;
      }
    }
  }

  /** Put the model-call pulse back to 0 (an item completed, a compaction, …). */
  resetPulse(reason = 'manual') {
    return this.pulse.reset(reason);
  }

  /**
   * Compact the window when it exceeds CONTEXT_MAX_LENGTH (or when forced).
   *
   * The step itself lives in `app/compaction-runner.js`; the summary call is a
   * *neutral* one (it opts out of the agent system prompt), so the summariser does
   * not answer as the agent, and it is metered like any other provider call.
   */
  async maybeCompact(signal, options = {}) {
    return this.compactionRunner.run(signal, options);
  }

  /**
   * Run the tool calls of one assistant message as a batch.
   *
   * The batch itself lives in `app/tool-batch.js`: the accepted calls are capped at
   * `MAX_PARALLEL_TOOL_CALLS`, dispatched simultaneously, and stored one chunk per
   * call in call order — each result inside the `<tool-multicall result>` envelope
   * that carries the call's signature (`docs/agent/tool-multicall`). Passing the
   * window, the log and the tool map in keeps this method the wiring only.
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
