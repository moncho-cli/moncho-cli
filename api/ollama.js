import { BASE_URL, API_KEY, MODEL, MODEL_TEMPERATURE, OLLAMA_MAX_TOKENS, THINKING_FILE as THINKING_TARGET, FILE_LINE_LIMIT, USER_AGENT, maintainerMode } from '../config/constants.js';
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

/**
 * The maintainer flow's own rules, appended to the prompt when this is the maintainer's
 * checkout — and **nothing at all** otherwise.
 *
 * `config/prompt.md` is the system prompt of every install, so it is read by a session
 * standing in a user's project. A rule about *this* tree ("do not commit, do not stage")
 * belongs there no more than the version-bump bookkeeping does (`docs/maintainer/version-bump`),
 * and `tests/mode-policy.test.js` states the same principle for the modes: an instruction
 * about a state the model cannot observe is prose it has to ignore. So the rule lives in its
 * own fragment (`config/maintainer-prompt.md`) and is concatenated at the end of the prompt
 * only when `config/constants.js#maintainerMode` says the tree is the maintainer's own.
 *
 * Absence is silence, the same contract `utils/project-rules.js` keeps: no fragment, an empty
 * one or an unreadable one answers `''`, and the request goes out exactly as it did before
 * the fragment existed.
 *
 * The path is a parameter so the absence rule can be proved against a file that really does
 * not exist — a test that deleted the shipped fragment to observe this would leave the tree
 * broken if it were interrupted between the delete and the restore.
 *
 * @param {boolean} [enabled] whether this is the maintainer's checkout
 * @param {{path?: string}} [options] the fragment to read; defaults to the shipped one
 * @returns {string} the fragment, introduced by a blank line, or `''`
 */
export function maintainerGuidance(enabled = maintainerMode(), { path: fragmentPath = path.join(__dirname, '..', 'config', 'maintainer-prompt.md') } = {}) {
  if (!enabled) return '';
  try {
    const text = fs.readFileSync(fragmentPath, 'utf-8').trim();
    return text ? `\n\n${text}` : '';
  } catch {
    return '';
  }
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
    return prompt
      + projectLanguageGuidance(process.env.PROJECT_LANGUAGE)
      + maintainerGuidance();
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

/**
 * Record one call's reasoning where the `Thinking` view can read it.
 *
 * The streaming branch appends each delta as it arrives, but **no production call site
 * streams** (`app/conversation-manager.js`, `app/compaction-runner.js` and `main.js` all
 * pass `isStreaming = false`, because `api/stream-reader.js#readStream` assembles content
 * and not `tool_calls`). So a capture written only from the streaming branch is written
 * by nothing, and the view that reads it opens on an empty file.
 *
 * This is the non-streaming half of the same rule: the reasoning the provider already
 * returned is written once, verbatim, at the start of the call that produced it. The file
 * is cleared first so it holds *this* call's reasoning rather than an older call's — the
 * capture is a view of the reasoning in flight, not a history (`docs/interface/thinking-view`).
 *
 * A reasoning that is missing, empty or not a string is the ordinary case — a model
 * without a reasoning channel, or a plain completion — and writes nothing at all, so the
 * file is left as the last real capture rather than truncated for nothing.
 *
 * Never throws: a capture is a view, and losing a view must not cost the reply.
 *
 * @param {unknown} thinking the reasoning the provider returned
 */
function captureThinking(thinking) {
  if (!THINKING_FILE) return;
  const text = typeof thinking === 'string' ? thinking : '';
  if (!text) return;
  try {
    fs.writeFileSync(THINKING_FILE, text, 'utf-8');
  } catch (error) {
    logEvent('warn', 'provider', 'could not write the thinking capture', error);
  }
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

/**
 * The headers a provider request carries: JSON, the configured `User-Agent` when one is
 * set, and the bearer token when an API key is configured. The user agent is **opt-in**
 * (`config/constants.js#USER_AGENT`), so an install that never set it sends no header of
 * its own. The parameter defaults to the configured value so the rule is a pure function
 * the tests can drive, mirroring `buildBody(..., baseUrl = BASE_URL)`.
 */
export function buildHeaders(userAgent = USER_AGENT) {
  const headers = { "Content-Type": "application/json" };
  if (userAgent) headers["User-Agent"] = userAgent;
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

        // The reasoning rides the same reply (api/provider-response.js keeps it), so
        // the `Thinking` view has a capture whether or not the call streamed.
        const payload = await response.json();
        captureThinking(payload?.message?.thinking);
        return normalizeResponse(payload);
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
