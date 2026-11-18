import { BASE_URL, API_KEY, MODEL } from '../config/constants.js';
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
    console.warn('Warning: Could not read prompt.md:', error.message);
    return '';
  }
}

async function clearThinkingFile() {
  fs.writeFileSync(THINKING_FILE, '', 'utf-8');
}

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

function normalizeResponse(data) {
  // Ollama shape: { message: { content, thinking, tool_calls } }
  if (data && data.message) {
    return {
      message: {
        content: data.message.content ?? "",
        tool_calls: normalizeToolCalls(data.message.tool_calls),
      },
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
    };
  }
  return { message: { content: "" } };
}

/**
 * @param {object[]} messages
 * @param {object[]|undefined} tools
 * @param {boolean} isStreaming
 * @param {AbortSignal|null} signal
 * @param {{systemPrompt?: boolean}} [options] `systemPrompt:false` omits the agent
 *   system prompt; internal calls (e.g. the context summariser behind task.md
 *   item 8) must not answer as Moncho.
 */
export async function callOllama(messages, tools, isStreaming = false, signal = null, options = {}) {
  const { systemPrompt = true } = options;

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
  const retryDelayMs = 5000;

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
        throw error;
      }
      if (attempt < maxRetries) {
        console.warn(`Ollama call failed (attempt ${attempt}/${maxRetries}): ${error.message}. Retrying in ${retryDelayMs/1000} seconds...`);
        await sleep(retryDelayMs);
      } else {
        throw error;
      }
    }
  }
}
