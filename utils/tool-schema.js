import {
  INTENT_PARAM_NAME,
  INTENT_PARAM_DESCRIPTION,
  MISSING_INTENT_PLACEHOLDER
} from '../config/constants.js';

/**
 * Tool-call contract shared by every tool in ./tools (task.md item 6).
 *
 * Every tool definition declared through `defineTool` automatically gains a
 * required `intent` parameter: a short phrase describing why the tool is being
 * called and what to do with the result. The contract is enforced in one place
 * so it can be printed (conversation-manager) and injected into the model
 * context without each tool repeating boilerplate.
 */

/** Parse tool arguments, which arrive as a JSON string or an already-parsed object. */
export function parseToolArgs(args) {
  if (args === undefined || args === null) return {};
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (trimmed === '') return {};
    return JSON.parse(trimmed);
  }
  if (typeof args === 'object') return args;
  throw new TypeError(`Unsupported tool arguments of type ${typeof args}.`);
}

/** Normalise an intent value to a single trimmed line. */
export function normalizeIntent(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

/** Read the intent out of parsed arguments, falling back to a visible placeholder. */
export function getIntent(parsedArgs, { placeholder = MISSING_INTENT_PLACEHOLDER } = {}) {
  return normalizeIntent(parsedArgs?.[INTENT_PARAM_NAME]) || placeholder;
}

/** Read the intent from raw (possibly JSON string) tool arguments. */
export function getIntentFromRaw(rawArgs, options) {
  try {
    return getIntent(parseToolArgs(rawArgs), options);
  } catch {
    return getIntent(null, options);
  }
}

/** Add the required `intent` property to a tool's JSON schema. */
export function withIntentParameter(parameters = {}) {
  const properties = {
    [INTENT_PARAM_NAME]: {
      type: 'string',
      description: INTENT_PARAM_DESCRIPTION
    },
    ...(parameters.properties || {})
  };
  const required = [
    INTENT_PARAM_NAME,
    ...(Array.isArray(parameters.required) ? parameters.required : [])
  ];
  return {
    ...parameters,
    type: 'object',
    properties,
    required: [...new Set(required)]
  };
}

/**
 * Declare a tool: builds its OpenAI-compatible definition (with `intent`) and
 * wraps `execute` so handlers receive parsed arguments plus the intent.
 *
 * @param {object} config
 * @param {string} config.name
 * @param {string} config.description
 * @param {object} [config.parameters] JSON schema for the tool's own parameters.
 * @param {(args: object, ctx: {intent: string, signal?: AbortSignal|null}) => Promise<any>|any} config.execute
 */
export function defineTool({ name, description, parameters = {}, execute }) {
  if (!name) throw new Error('defineTool requires a name.');
  if (typeof execute !== 'function') throw new Error(`Tool ${name} requires an execute function.`);

  const definition = {
    type: 'function',
    function: {
      name,
      description: `${description} Call arguments must include "intent": ${INTENT_PARAM_DESCRIPTION}`,
      parameters: withIntentParameter(parameters)
    }
  };

  // `ctx` carries what the *dispatcher* knows and the tool needs: the intent, and the
  // running task's AbortSignal. A tool that spawns a child (run_bash, run_npm) uses the
  // signal to kill it when the user cancels, so cancellation reaches the process and not
  // merely the promise waiting on it.
  const wrapped = async (args, ctx = {}) => {
    const parsedArgs = parseToolArgs(args);
    const intent = getIntent(parsedArgs);
    return execute(parsedArgs, { intent, ...ctx });
  };

  return { definition, execute: wrapped };
}

/** True when a definition exposes the required `intent` parameter. */
export function hasIntentParameter(definition) {
  const params = definition?.function?.parameters;
  return Boolean(params?.properties?.[INTENT_PARAM_NAME])
    && Array.isArray(params.required)
    && params.required.includes(INTENT_PARAM_NAME);
}
