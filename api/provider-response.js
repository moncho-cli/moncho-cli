/**
 * The two provider response shapes, normalised into one.
 *
 * A provider answers in one of two dialects:
 *  - the **Ollama** shape: `{ message: { content, thinking, tool_calls } }`;
 *  - the **OpenAI-compatible** shape: `{ choices: [ { message: { content, tool_calls } } ] }`.
 *
 * The rest of the harness must not know which one it got, so this module turns both
 * into `{ message: { content, tool_calls }, usage }` — and the tool calls into the one
 * shape the conversation stores: an id, the type `function`, and the arguments as a
 * **JSON string** (a provider that hands them over as an object is stringified here,
 * so nothing downstream has to guess).
 *
 * It is the pure half of the provider layer: no network, no clock, no log. The module
 * it was extracted from (`api/ollama.js`) re-exports `normalizeUsage()` under its own
 * name, so every existing import and every spec keeps pointing at the same symbol.
 */

/** The tool calls of one provider message, in the one shape the conversation stores. */
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

/**
 * One provider response, in the one shape the conversation and the meter read.
 *
 * A payload with neither shape still yields a message with empty content, so the
 * caller always has something to read.
 */
export function normalizeResponse(data) {
  const usage = normalizeUsage(data);
  // Ollama shape: { message: { content, thinking, tool_calls } }
  if (data && data.message) {
    return {
      message: {
        content: data.message.content ?? "",
        // The reasoning is kept, not dropped: it is what the `Thinking` view reads
        // (`docs/interface/thinking-view`), and a non-streaming call has no other way
        // to hand it over. An empty one is left out, so a reply without reasoning is
        // shaped exactly as it was before this field existed.
        ...(typeof data.message.thinking === 'string' && data.message.thinking
          ? { thinking: data.message.thinking }
          : {}),
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
