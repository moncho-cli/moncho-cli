/**
 * Recording a provider call that failed.
 *
 * The *pure* half of the diagnosis — what a request looked like, what a provider said
 * about it, whether the tool calls in a history are answered — lives in
 * `api/provider-analysis.js`, where it touches no network and no log. This module is
 * the half that **acts**: it reads the error body off the wire, records the whole
 * record in the operational log, and hands back the error the call raises.
 *
 * Why the record matters: a chat provider refuses a request because of its *shape*,
 * and its own body says why ("messages with role 'tool' must be a response to a
 * preceding message with 'tool_calls'"). The harness used to throw the status away
 * (`HTTP error! status: 400`), leaving an operator with a number and nothing to act on.
 * The record keeps the status, the provider's reason, the shape of the request that
 * was sent, and the tool-call pairing — enough to tell "the provider is broken" from
 * "this session's history is broken" (a history that answers 400 forever while a new
 * session works).
 *
 * The log is not a second transcript (`docs/runtime/logging`): the request is
 * described by its shape, never by the words of the conversation. Only the provider's
 * own error body is quoted, because that is the diagnosis.
 *
 * Nothing here can throw: a body that cannot be read is reported as unreadable, and
 * the log call itself never throws (`utils/logger.js#logEvent`).
 */

import { logEvent } from '../utils/logger.js';
import {
  MAX_ERROR_BODY_CHARS,
  buildProviderDiagnostic,
  formatProviderDiagnostic,
} from './provider-analysis.js';

export { MAX_ERROR_BODY_CHARS };

/**
 * Read an error body without ever throwing and without ever keeping more than the cap.
 *
 * `response.text()` is the one call that can fail on a connection that died mid-body;
 * a body we cannot read is a body we report as unreadable rather than lose the record.
 *
 * @param {object} response the fetch response
 * @returns {Promise<string>} the body text, truncated to the cap
 */
export async function readErrorBody(response) {
  try {
    if (!response || typeof response.text !== 'function') return '';
    const text = await response.text();
    const body = String(text ?? '');
    return body.length > MAX_ERROR_BODY_CHARS
      ? `${body.slice(0, MAX_ERROR_BODY_CHARS)}… (truncated)`
      : body;
  } catch {
    return '';
  }
}

/**
 * The error one failed call raises, carrying the diagnostic with it.
 *
 * The message names the status and the provider's reason — the reason is what the
 * reader needs, and it is the provider's own words, not ours. `status` is on the error
 * so a caller can tell an HTTP refusal from an abort (`app/turn-runner.js#isAbortFailure`).
 */
export class ProviderHttpError extends Error {
  constructor(diagnostic = {}) {
    const status = diagnostic.status ?? 'unknown';
    const reason = diagnostic.reason ? ` — ${diagnostic.reason}` : '';
    super(`HTTP error! status: ${status}${reason}`);
    this.name = 'ProviderHttpError';
    this.status = diagnostic.status ?? null;
    this.diagnostic = diagnostic;
  }
}

/**
 * Record one failed provider call and return the error to raise.
 *
 * The record is the point of this module: the status alone never says why, and the
 * provider's reason is only useful next to the shape of the request that provoked it.
 *
 * The level follows the fate of the attempt: an attempt that will be retried is a
 * `warn` (something recovered from), the last one is an `error` (something that ended
 * the work) — the same rule the rest of the log follows (`docs/runtime/logging`).
 *
 * @param {object} options
 * @param {object} options.response the fetch response that failed
 * @param {object[]} [options.messages] the history the request carried
 * @param {object[]} [options.tools] the advertised tool schemas
 * @param {boolean} [options.stream] whether the request was a streaming one
 * @param {string} [options.url] the endpoint the request went to
 * @param {string} [options.model] the model the request asked for
 * @param {number} [options.attempt] the attempt this failure belongs to
 * @param {number} [options.maxRetries] how many attempts there are in all
 * @returns {Promise<ProviderHttpError>} the error to raise
 */
export async function recordProviderFailure({
  response = null,
  messages = [],
  tools = [],
  stream = false,
  url = '',
  model = '',
  attempt = 1,
  maxRetries = 1,
} = {}) {
  const body = await readErrorBody(response);
  const diagnostic = buildProviderDiagnostic({ response, body, messages, tools, stream, url, model });
  const level = attempt < maxRetries ? 'warn' : 'error';
  logEvent(level, 'provider', formatProviderDiagnostic(diagnostic), diagnostic);
  return new ProviderHttpError(diagnostic);
}
