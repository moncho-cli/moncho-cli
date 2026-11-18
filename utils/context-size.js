/**
 * Context-window size resolution (task.md item 3).
 *
 * The size that matters for compaction is the *real* context length of the model
 * the provider serves. When the provider exposes it over HTTP we read it; when a
 * config override (CONTEXT_MAX_LENGTH) is also present the override wins as the
 * working budget but the UI must still show both, e.g.
 * "128k configured (total: 1.0M)".
 *
 * Everything here is pure aside from `resolveContextSize`, which takes its fetch
 * implementation, base URL and clock as arguments so it is fully testable and
 * never performs a network call at import time.
 */

import { parseTokenBudget, formatTokenCount } from './tokens.js';

/** Fallback budget when neither the provider nor a config supplies a size. */
export const DEFAULT_CONTEXT_MAX_LENGTH = 128000;

/** Where a resolved size came from. */
export const CONTEXT_SIZE_SOURCE = {
  CONFIGURED: 'configured',
  API: 'api',
  DEFAULT: 'default',
};

/**
 * Extract a real context length from a provider payload.
 *
 * Handles the two shapes the harness talks to:
 *  - OpenRouter/OpenAI: `{ data: [ { id, context_length, top_provider } ] }`
 *  - Ollama `/api/show`: `{ model_info: { "<arch>.context_length": N }, ... }`
 *
 * @param {unknown} payload
 * @param {{ model?: string }} [options]
 * @returns {number|null} a positive integer, or null when none is found
 */
export function parseContextLength(payload, { model } = {}) {
  if (!payload || typeof payload !== 'object') return null;

  const positive = (value) => {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

  // Ollama /api/show: model_info carries "<architecture>.context_length".
  const info = payload.model_info;
  if (info && typeof info === 'object') {
    const key = Object.keys(info).find((k) => /\.context_length$/.test(k));
    const fromInfo = positive(key ? info[key] : null);
    if (fromInfo) return fromInfo;
  }

  // Ollama also exposes parameters as a newline string ("num_ctx 8192").
  if (typeof payload.parameters === 'string') {
    const match = payload.parameters.match(/num_ctx\s+(\d+)/);
    const fromParams = positive(match ? match[1] : null);
    if (fromParams) return fromParams;
  }

  // OpenRouter/OpenAI models list.
  const list = Array.isArray(payload) ? payload : payload.data || payload.models;
  if (Array.isArray(list)) {
    const wanted = String(model ?? '');
    const match = list.find((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const id = entry.id || entry.name || entry.model;
      return wanted ? id === wanted : true;
    });
    if (match) {
      const direct = positive(match.context_length ?? match.contextLength);
      if (direct) return direct;
      const top = positive(match.top_provider?.context_length);
      if (top) return top;
    }
  }

  // A bare `{ context_length }` (some gateways) as a last resort.
  return positive(payload.context_length ?? payload.contextLength);
}

/** Build the metadata endpoint for the configured provider base URL. */
export function contextLengthEndpoint(baseUrl) {
  const raw = String(baseUrl || '');
  try {
    const url = new URL(raw);
    if (/:11434\b|\/api\/chat/.test(raw)) {
      // Ollama: /api/chat -> /api/show (fetched with POST + { model }).
      url.pathname = url.pathname.replace(/\/api\/chat\/?$/, '/api/show');
      return { url: url.toString(), method: 'POST', kind: 'ollama' };
    }
    url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, '/models');
    url.search = '';
    return { url: url.toString(), method: 'GET', kind: 'openai' };
  } catch {
    return null;
  }
}

function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * Resolve the working context budget for the currently configured model.
 *
 * Resolution order for the working budget:
 *   1. a config override (CONTEXT_MAX_LENGTH) — the user asked for this size;
 *   2. the real total reported by the provider over HTTP;
 *   3. DEFAULT_CONTEXT_MAX_LENGTH.
 *
 * The provider total is always reported separately in `realTokens` so the UI can
 * render "configured (total: real-total)" when an override differs from it.
 *
 * @param {object} options
 * @param {string|number|null} [options.configured] Config override, if any.
 * @param {string} [options.baseUrl]
 * @param {string} [options.model]
 * @param {string} [options.apiKey]
 * @param {Function} [options.fetchImpl] Injected fetch (defaults to global fetch).
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{maxTokens:number, configuredTokens:number|null, realTokens:number|null, source:string}>}
 */
export async function resolveContextSize({
  configured = null,
  baseUrl = '',
  model = '',
  apiKey = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 4000,
} = {}) {
  const configuredTokens = parseTokenBudget(configured);
  const fallback = configuredTokens ?? DEFAULT_CONTEXT_MAX_LENGTH;

  let realTokens = null;
  const endpoint = contextLengthEndpoint(baseUrl);
  if (endpoint && typeof fetchImpl === 'function') {
    const timeout = withTimeout(timeoutMs);
    try {
      const response = await fetchImpl(endpoint.url, {
        method: endpoint.method,
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        ...(endpoint.method === 'POST' ? { body: JSON.stringify({ model }) } : {}),
        signal: timeout.signal,
      });
      if (response && response.ok) {
        const payload = await response.json();
        realTokens = parseContextLength(payload, { model });
      }
    } catch {
      // Best effort: an unreachable provider must never block startup.
      realTokens = null;
    } finally {
      timeout.clear();
    }
  }

  if (configuredTokens) {
    return {
      maxTokens: configuredTokens,
      configuredTokens,
      realTokens,
      source: CONTEXT_SIZE_SOURCE.CONFIGURED,
    };
  }

  if (realTokens) {
    return {
      maxTokens: realTokens,
      configuredTokens: null,
      realTokens,
      source: CONTEXT_SIZE_SOURCE.API,
    };
  }

  return {
    maxTokens: fallback,
    configuredTokens: null,
    realTokens: null,
    source: CONTEXT_SIZE_SOURCE.DEFAULT,
  };
}

/**
 * Human-readable context limit (task.md item 3).
 *
 * When a config override differs from the real total reported by the provider the
 * label reads "<configured> configured (total: <real>)", so the user can see at a
 * glance that they asked for a smaller budget than the model actually supports.
 */
export function formatContextLimit({ maxTokens, configuredTokens = null, realTokens = null, source } = {}) {
  const configured = parseTokenBudget(configuredTokens);
  const real = parseTokenBudget(realTokens);
  const effective = parseTokenBudget(maxTokens) ?? configured ?? real ?? DEFAULT_CONTEXT_MAX_LENGTH;

  if (configured && real && configured !== real) {
    return `${formatTokenCount(configured)} configured (total: ${formatTokenCount(real)})`;
  }
  if (configured && !real) {
    return `${formatTokenCount(configured)} configured`;
  }
  if (source === CONTEXT_SIZE_SOURCE.API && real) {
    return `${formatTokenCount(real)} (from API)`;
  }
  return `${formatTokenCount(effective)}`;
}
