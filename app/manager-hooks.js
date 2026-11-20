import { formatRetryNotice } from './notice-overlay.js';
import { recordProviderCall, totalUsage } from '../utils/usage-stats.js';

/**
 * The `ConversationManager`'s host-facing halves, kept out of the class.
 *
 * Two very different jobs live here, and both are *thin*: they only forward what the
 * manager holds to the host, or account what a call cost. Neither owns state, so the
 * manager's methods are one-line delegations and the class stays a *state* object
 * (`docs/runtime/startup-wiring`).
 *
 * 1. **The hooks.** The manager announces what happened — the window changed, the
 *    conversation changed, a notice, a retried attempt, one side of the dialogue
 *    (`announceProse`) — and every hook is
 *    presentation-adjacent, so a listener that throws must never cost the user their
 *    turn (`docs/context/usage-refresh`). `announceChunksChange` is the *event* the
 *    host autosaves on (a chunk landed, a compaction rewrote the array) while
 *    `announceContextChange` is the *meter*, repainted even before a call that adds
 *    nothing.
 * 2. **The accounting.** One provider call is timed as a *thinking* span and one tool
 *    batch as a *tool* span (`docs/context/working-time`), and the tokens a call cost
 *    are recorded against the model that answered. The time is host state — never a
 *    chunk, never sent to the provider — and the committed part of it lands in the
 *    usage table the session file keeps.
 */

/** Announce the window's stats. A throwing listener is swallowed; none is a no-op. */
export function announceContextChange(host) {
  if (!host.onContextChange) return null;
  const stats = host.contextWindow.stats();
  try {
    host.onContextChange(stats);
  } catch {
    // display only: a broken meter must not break the conversation
  }
  return stats;
}

/** Announce that the conversation changed. Presentation-adjacent, so forgiving. */
export function announceChunksChange(host, reason = 'chunk') {
  if (!host.onChunksChange) return null;
  try {
    return host.onChunksChange(reason) ?? null;
  } catch {
    return null;
  }
}

/**
 * Print one side of the dialogue on the prose route.
 *
 * `role` is `user` or `assistant` and names the band the row is painted with
 * (`docs/interface/prose-bands`); the hook is presentation only, so a listener that
 * throws must never cost the user their turn — the caller falls back to `log()`.
 */
export function announceProse(host, role, text) {
  if (!host.onProse) return null;
  try {
    return host.onProse(role, text);
  } catch {
    return null;
  }
}

/** Show a transient notice. Without a hook the message is dropped, not printed. */
export function announceNotice(host, kind, text, options = {}) {
  if (!host.onNotice) return null;
  try {
    return host.onNotice(kind, text, options);
  } catch {
    return null;
  }
}

/** Report one retried attempt (the `onRetry` hook of api/ollama.js). */
export function announceRetry(host, report = {}) {
  return announceNotice(host, 'warn', formatRetryNotice(report), { code: 'retry' });
}

/**
 * Count one finished provider call against the model that answered it.
 *
 * The provider's own counters are used when it reports them, and the measured prompt
 * plus the answered text are the fallback — flagged as an estimate, never passed off
 * as exact (`docs/context/token-accounting`).
 */
export function accountUsage(host, response, promptTokens = 0) {
  return recordProviderCall(host.usage, host.model, { response, promptTokens });
}

/**
 * Account one closed span against the model whose work it was, so `/usage` and a
 * resumed session report the time the way they report the tokens.
 */
export function accountWorkTime(host, { kind = 'thinking', ms = 0 } = {}) {
  const field = kind === 'tool' ? { toolMs: ms } : { thinkingMs: ms };
  return host.usage.recordTime(host.model, field);
}

/**
 * The working-time totals the host paints: everything already accounted (a resumed
 * session included) **plus** the spans still open, so the number a row shows is
 * current instead of one span stale.
 */
export function workingTotals(host) {
  const stored = totalUsage(host.usage.table());
  const open = host.working.openTotals();
  return {
    thinkingMs: stored.thinkingMs + open.thinkingMs,
    toolMs: stored.toolMs + open.toolMs,
    totalMs: stored.thinkingMs + stored.toolMs + open.totalMs,
    stored: { thinkingMs: stored.thinkingMs, toolMs: stored.toolMs },
  };
}

/**
 * Wrap a provider call in a *thinking* span, so the wall clock the model spent
 * answering is counted even when the call ends in a failure (the span is closed in a
 * `finally`), and accounted against the model that answered.
 */
export function timeCallModel(host, callModel) {
  return async (...args) => {
    const span = host.working.begin('thinking');
    try {
      return await callModel(...args);
    } finally {
      accountWorkTime(host, { kind: 'thinking', ms: host.working.end(span) });
    }
  };
}
