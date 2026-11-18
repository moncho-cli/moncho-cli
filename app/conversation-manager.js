import { callOllama } from '../api/ollama.js';
import { CONTEXT_MAX_LENGTH } from '../config/constants.js';
import { ContextWindow } from './context-window.js';
import { registerContextWindow } from '../utils/host.js';
import {
  formatArgs as summarizeArgs,
  formatCallLines,
  formatToolResultChunk,
  normalizeToolCall,
} from './tool-call-format.js';

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

    while (true) {
      const signal = this.getAbortSignal();

      // Task.md item 8: never call the model with an over-budget window.
      await this.maybeCompact(signal);

      try {
        const data = await callOllama(this.contextWindow.chunks, this.getTools(), false, signal);

        // Treat null or empty response as an error and retry
        if (!data || !data.message) {
          this.log("\nError: Received null/empty API response. Retrying...");
          continue;
        }

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
          const response = await callOllama(messages, [], false, ctx.signal, { systemPrompt: false });
          return response?.message?.content ?? '';
        }
      });

      if (result.compacted) {
        this.log(`\n[Context] Compacted ${result.olderChunks} older chunk(s) into a summary (${result.olderTokens} -> ${result.afterTokens} tokens).`);
        this.log(`[Context] Window: ${result.usage}`);
        if (this.onContextChange) this.onContextChange(this.contextWindow.stats());
      }
      return result;
    } catch (error) {
      // A failed compaction must never break the task; the window is unchanged.
      this.log(`\n[Context] Compaction skipped: ${error.message}`);
      return { compacted: false, reason: 'error', error: error.message };
    }
  }

  async handleToolCalls(toolCalls, signal) {
    // Emit a single, OpenAI-compatible assistant chunk carrying all tool calls.
    this.contextWindow.add({
      role: "assistant",
      content: null,
      tool_calls: toolCalls.map((tc, i) => ({
        id: tc.id || `call_${i}`,
        type: tc.type || "function",
        function: {
          name: tc.function.name,
          arguments:
            typeof tc.function.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments ?? {}),
        },
      })),
    });

    let compactionRequested = false;

    for (const toolCall of toolCalls) {
      if (signal?.aborted) break;
      // The call's shape (name, parsed args, intent) comes from the shared
      // formatter, so the printed lines and the replay agree by construction.
      const call = normalizeToolCall(toolCall, toolCalls.indexOf(toolCall));
      const { name: functionName, rawArgs, intent } = call;
      const callId = call.id;
      for (const line of formatCallLines(call)) {
        this.log(line);
      }

      let result;
      let isError = false;
      try {
        result = await this.toolFunctions[functionName](rawArgs);
      } catch (error) {
        isError = true;
        result = `Error executing ${functionName}: ${error.message}`;
      }

      if (detectCompactionRequest(result)) compactionRequested = true;

      // The intent is part of the tool result chunk, so it stays in the model's
      // context (task.md item 6) instead of only being printed to the terminal.
      this.contextWindow.add({
        role: "tool",
        tool_call_id: callId,
        content: this.formatToolChunk({ functionName, intent, result, isError })
      });
    }

    return compactionRequested;
  }

  /** Render a tool result chunk, prefixing it with the call's intent. */
  formatToolChunk({ functionName, intent, result, isError }) {
    // The shape lives in ./tool-call-format.js#formatToolResultChunk, so the
    // session replay unwraps exactly what the loop stored.
    return formatToolResultChunk({ intent, result, isError });
  }

  async handleFinalResponse(content) {
    this.contextWindow.add({ role: "assistant", content });

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

/** True when a compact_context result asks the host loop to run a compaction. */
export function detectCompactionRequest(result) {
  if (typeof result !== 'string') return false;
  try {
    const parsed = JSON.parse(result);
    return parsed?.code === 'COMPACTION_REQUESTED' && parsed?.defer === true;
  } catch {
    return false;
  }
}
