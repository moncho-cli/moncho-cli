import { BASE_URL, API_KEY, MODEL, MODEL_TEMPERATURE, OLLAMA_MAX_TOKENS, THINKING_FILE as THINKING_TARGET, FILE_LINE_LIMIT } from '../config/constants.js';
import { logEvent } from '../utils/logger.js';
import { resolveProjectPath } from '../utils/path-safety.js';
import { recordProviderFailure } from './provider-diagnostics.js';
import { normalizeResponse } from './provider-response.js';
import { readStream } from './stream-reader.js';
import { renderFileLineLimit, unresolvedPlaceholders } from '../utils/file-size-budget.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/**
 * Where the streaming reasoning is captured. The path comes from
 * `config/constants.js#THINKING_FILE` and goes through the same sandbox every file
 * tool uses, so an absolute or escaping value is refused instead of writing outside
 * the workspace. A path that cannot be resolved turns the capture **off** rather than
 * failing the call: losing a reasoning trace must never cost the user their turn.
 */
function resolveThinkingPath() {
  try {
    return resolveProjectPath(THINKING_TARGET);
  } catch (error) {
    logEvent('warn', 'provider', 'THINKING_FILE cannot be resolved inside the project; the capture is off', error);
    return null;
  }
}

const THINKING_FILE = resolveThinkingPath();

export function projectLanguageGuidance(value) {
  const language = typeof value === 'string' ? value.trim() : '';
  return language ? `\n\nProject artifact language preference: ${JSON.stringify(language)}. Follow project rules and existing conventions when applying it.` : '';
}

async function loadSystemPrompt() {
  // config/prompt.md, not the module root: the prompt is agent *data*, and keeping
  // every shipped asset inside a directory means the image copies it with the rest
  // instead of naming it a second time (Dockerfile.agent).
  const promptPath = path.join(__dirname, '..', 'config', 'prompt.md');
  try {
    const raw = fs.readFileSync(promptPath, 'utf-8').trim();
    // The file size budget is **configured** (`FILE_LINE_LIMIT`), and the prompt is
    // where the model reads it — so the configured numbers are rendered into the
    // prompt here. A placeholder that survived would tell the model nothing, so it
    // is reported rather than shipped.
    const prompt = renderFileLineLimit(raw, { limit: FILE_LINE_LIMIT });
    const unresolved = unresolvedPlaceholders(prompt);
    if (unresolved.length > 0) {
      logEvent('error', 'provider', 'the agent prompt still carries an unrendered placeholder', {
        placeholders: unresolved,
      });
    }
    return prompt + projectLanguageGuidance(process.env.PROJECT_LANGUAGE);
  } catch (error) {
    // The agent answers without its prompt from here on, which is exactly the kind
    // of silent degradation this log exists to make findable.
    logEvent('error', 'provider', 'could not read config/prompt.md; the agent prompt is empty', error);
    console.warn('Warning: Could not read config/prompt.md:', error.message);
    return '';
  }
}

async function clearThinkingFile() {
  if (!THINKING_FILE) return;
  fs.writeFileSync(THINKING_FILE, '', 'utf-8');
}

/** How long to wait before retrying a failed attempt. */
const RETRY_DELAY_MS = 5000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let systemPromptCache = null;

/**
 * Whether a provider is Ollama, judged from its base URL: its default port or its
 * native chat path. The parameter is the URL to test, defaulting to the configured
 * one, so the decision is a pure function of a URL and can be exercised without a
 * live provider.
 */
export function isOllamaProvider(baseUrl = BASE_URL) {
  return /:11434\b|\/api\/chat/.test(baseUrl);
}

/**
 * Whether the base URL is an OpenAI-compatible surface (a `…/v1/…` path). Ollama
 * serves one next to its native API, and the two read a response cap differently —
 * `max_tokens` here, `options.num_predict` there.
 */
function isOpenAiCompatibleSurface(baseUrl = BASE_URL) {
  return /\/v1\//.test(baseUrl);
}

function buildHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
  return headers;
}

export function buildBody(messages, tools, stream, baseUrl = BASE_URL) {
  const body = { model: MODEL, messages, stream };
  const toolList = Array.isArray(tools) ? tools : [];
  if (toolList.length > 0) body.tools = toolList;
  // The sampling temperature is sent only when the user configured one, so the
  // provider's own default applies otherwise (`config/constants.js#MODEL_TEMPERATURE`).
  // Sending an explicit `undefined` would serialise away in JSON, but omitting the key
  // outright keeps the request byte-identical to what it was before the knob existed.
  if (MODEL_TEMPERATURE !== null) body.temperature = MODEL_TEMPERATURE;
  // A cap on generated tokens, so a thinking model settles on an answer instead of
  // generating until the request dies. Only Ollama gets one — it is the provider this
  // knob exists for — and it is placed where that surface reads it: `max_tokens` for
  // Ollama's OpenAI-compatible API, `options.num_predict` for its native /api/chat.
  // `null` means no cap is sent and the provider's own default applies.
  if (OLLAMA_MAX_TOKENS !== null && isOllamaProvider(baseUrl)) {
    if (isOpenAiCompatibleSurface(baseUrl)) body.max_tokens = OLLAMA_MAX_TOKENS;
    else body.options = { ...body.options, num_predict: OLLAMA_MAX_TOKENS };
  }
  
  if (stream && isOllamaProvider(baseUrl)) body.think = true; // Ollama-only flag
  return body;
}

// The response shapes are normalised in their own module (api/provider-response.js);
// `normalizeUsage()` is re-exported here because it is the symbol the specs and the
// accounting layer name.
export { normalizeUsage } from './provider-response.js';

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
          // A non-200 is recorded before it is raised: the status alone never says why,
          // so the log keeps the provider's own reason, the shape of the request that
          // provoked it, and whether the tool calls in that history are still answered
          // (api/provider-diagnostics.js). A streaming request is refused on exactly the
          // same grounds, so both branches record the same record.
          throw await recordProviderFailure({
            response,
            messages: ollamaMessages,
            tools,
            stream: isStreaming,
            url: BASE_URL,
            model: MODEL,
            attempt,
            maxRetries,
          });
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
          // A non-200 is recorded before it is raised: the status alone never says why,
          // so the log keeps the provider's own reason, the shape of the request that
          // provoked it, and whether the tool calls in that history are still answered
          // (api/provider-diagnostics.js). A streaming request is refused on exactly the
          // same grounds, so both branches record the same record.
          throw await recordProviderFailure({
            response,
            messages: ollamaMessages,
            tools,
            stream: isStreaming,
            url: BASE_URL,
            model: MODEL,
            attempt,
            maxRetries,
          });
        }

        const reader = response.body.getReader();

        // Clear the thinking file at the start of streaming
        await clearThinkingFile();

        // The line buffering lives in api/stream-reader.js: a read boundary routinely cuts
        // a JSON payload in half, and splitting each read on its own threw the partial line
        // away — the dropped delta was the missing space in the prose.
        const fullResponse = await readStream(reader, {
          onContent: (text) => process.stdout.write(text),
          onThinking: (text) => {
            if (THINKING_FILE) fs.appendFileSync(THINKING_FILE, text, 'utf-8');
          },
          onDone: () => console.log("\n\n[Streaming complete]"),
        });

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
