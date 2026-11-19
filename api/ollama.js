import { BASE_URL, API_KEY, MODEL } from '../config/constants.js';
import { logEvent } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const THINKING_FILE = path.join(__dirname, '..', 'thinking.md');

async function loadSystemPrompt() {
  const promptPath = path.join(__dirname, '..', 'prompt.md');
  try {
    return fs.readFileSync(promptPath, 'utf-8').trim();
  } catch (error) {
    // The agent answers without its prompt from here on, which is exactly the kind
    // of silent degradation this log exists to make findable.
    logEvent('error', 'provider', 'could not read prompt.md; the agent prompt is empty', error);
    console.warn('Warning: Could not read prompt.md:', error.message);
    return '';
  }
}

async function clearThinkingFile() {
  fs.writeFileSync(THINKING_FILE, '', 'utf-8');
}

/** How long to wait before retrying a failed attempt. */
const RETRY_DELAY_MS = 5000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let systemPromptCache = null;

function isOllamaProvider() {
  return /:11434\b|\/api\/chat/.test(BASE_URL);
}

function buildHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
  return headers;
}

function buildBody(messages, tools, stream) {
  const body = { model: MODEL, messages, stream };
  const toolList = Array.isArray(tools) ? tools : [];
  if (toolList.length > 0) body.tools = toolList;
  if (stream && isOllamaProvider()) body.think = true; // Ollama-only flag
  return body;
}

function normalizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return undefined;
  return toolCalls.map((tc, i) => ({
    id: tc.id || `call_${i}`,
    type: tc.type || "function",
    function: {
      name: tc.function?.name,
      arguments:
        typeof tc.function?.arguments === "string"
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments ?? {}),
    },
  }));
}

/**
 * The token counters of one provider response, in one shape, or null.
 *
 * Providers spell usage differently — OpenAI-compatible APIs answer with
 * `usage: { prompt_tokens, completion_tokens, total_tokens }`, Ollama with the
 * flat `prompt_eval_count` / `eval_count` on the response root — so this is the
 * only place that knows both. Returning **null** for a provider that reports
 * nothing is deliberate: the accounting layer must be able to tell an exact
 * count from its own estimate (`utils/usage-stats.js`).
 */
export function normalizeUsage(data) {
  const usage = data?.usage || data?.message?.usage || null;
  const prompt = usage?.prompt_tokens ?? data?.prompt_eval_count;
  const completion = usage?.completion_tokens ?? data?.eval_count;
  if (prompt == null && completion == null) return null;

  const promptTokens = Number(prompt) || 0;
  const completionTokens = Number(completion) || 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: Number(usage?.total_tokens) || promptTokens + completionTokens,
  };
}

function normalizeResponse(data) {
  const usage = normalizeUsage(data);
  // Ollama shape: { message: { content, thinking, tool_calls } }
  if (data && data.message) {
    return {
      message: {
        content: data.message.content ?? "",
        tool_calls: normalizeToolCalls(data.message.tool_calls),
      },
      usage,
    };
  }
  // OpenAI-compatible shape: { choices: [ { message: { content, tool_calls } } ] }
  const choice = data?.choices?.[0]?.message;
  if (choice) {
    return {
      message: {
        content: choice.content ?? "",
        tool_calls: normalizeToolCalls(choice.tool_calls),
      },
      usage,
    };
  }
  return { message: { content: "" }, usage };
}

/**
 * @param {object[]} messages
 * @param {object[]|undefined} tools
 * @param {boolean} isStreaming
 * @param {AbortSignal|null} signal
 * @param {{systemPrompt?: boolean}} [options] `systemPrompt:false` omits the agent
 *   system prompt; internal calls (e.g. the context summariser behind task.md
 *   item 8) must not answer as Moncho.
 * @param {number} [options.retryDelayMs] how long to wait between attempts
 *   (`RETRY_DELAY_MS` by default). Overridable so the retry path is testable without
 *   a five-second wait.
 * @param {Function} [options.onRetry] called with `{ attempt, maxRetries, delayMs,
 *   error }` before a failed attempt is retried. A recovered attempt is *news*, not
 *   history, so the host shows it in the transient notice overlay instead of
 *   leaving an error line in the transcript forever (app/notice-overlay.js).
 */
export async function callOllama(messages, tools, isStreaming = false, signal = null, options = {}) {
  const { systemPrompt = true, onRetry = null, retryDelayMs = RETRY_DELAY_MS } = options;

  // Load system prompt if not cached or if cache is empty
  if (systemPrompt && !systemPromptCache) {
    systemPromptCache = await loadSystemPrompt();
  }

  // Create messages array with system prompt first, then user messages
  const ollamaMessages = [];
  
  if (systemPrompt && systemPromptCache) {
    ollamaMessages.push({ role: "system", content: systemPromptCache });
  }
  
  ollamaMessages.push(...messages);

  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (!isStreaming) {
        // Non-streaming call
        const response = await fetch(BASE_URL, {
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify(buildBody(ollamaMessages, tools, false)),
          signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        return normalizeResponse(await response.json());
      } else {
        // Streaming call with thinking capture
        const response = await fetch(BASE_URL, {
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify(buildBody(ollamaMessages, tools, true)),
          signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullResponse = '';
        
        // Clear the thinking file at the start of streaming
        await clearThinkingFile();

        while (true) {
          const { done, value } = await reader.read();
          
          if (done) {
            break;
          }
          
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;
            if (line === 'data: [DONE]' || line === '[DONE]') {
              console.log("\n\n[Streaming complete]");
              continue;
            }
            const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
            try {
              const parsed = JSON.parse(payload);
              const delta = parsed.message || parsed.choices?.[0]?.delta || {};
              if (delta.content) {
                if (delta.thinking || (parsed.message && parsed.message.thinking)) {
                  fs.appendFileSync(THINKING_FILE, delta.content, 'utf-8');
                } else {
                  fullResponse += delta.content;
                  process.stdout.write(delta.content);
                }
              }
              if (parsed.done) {
                console.log("\n\n[Streaming complete]");
              }
            } catch (e) {
              // Ignore non-JSON keep-alive / SSE framing lines.
            }
          }
        }

        return fullResponse;
      }
    } catch (error) {
      // A cancelled task must stop immediately; retrying would ignore the
      // user's ESC / Ctrl+C and stall the prompt.
      if (signal?.aborted || error.name === 'AbortError') {
        logEvent('info', 'provider', 'call aborted by the user');
        throw error;
      }
      if (attempt < maxRetries) {
        const report = { attempt, maxRetries, delayMs: retryDelayMs, error };
        // One line per retried attempt: the transcript shows a transient notice, the
        // log keeps the record that outlives the session.
        logEvent('warn', 'provider', `attempt ${attempt}/${maxRetries} failed; retrying in ${retryDelayMs}ms`, error);
        if (typeof onRetry === 'function') {
          try {
            onRetry(report);
          } catch {
            // display only: a broken notice hook must never cost the user the retry
          }
        } else {
          console.warn(`Ollama call failed (attempt ${attempt}/${maxRetries}): ${error.message}. Retrying in ${retryDelayMs/1000} seconds...`);
        }
        await sleep(retryDelayMs);
      } else {
        logEvent('error', 'provider', `attempt ${attempt}/${maxRetries} failed; giving up`, error);
        throw error;
      }
    }
  }
}
