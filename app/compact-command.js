/**
 * `/compact` — compact the context window now, at the user's request.
 *
 * The window compacts itself when a turn pushes it past its budget
 * (`app/context-window.js#ContextWindow.needsCompaction`) and the model can *ask* for
 * one through the `compact_context` tool, but until now the person driving the session
 * had no way to say "summarise this now" without waiting for the budget to be reached.
 * This command is that switch: it moves the very same state the turn loop moves, so
 * there is one compaction mechanism and two ways to reach it.
 *
 * Three decisions are worth naming:
 *
 *  - **a bare `/compact` is honest, not forceful.** It runs the ordinary budget check,
 *    so a window that still fits reports `WITHIN_BUDGET` and is left exactly as it was.
 *    `/compact force` is the explicit override, which is also the only shape that can
 *    summarise a window holding a single older block.
 *  - **the summary call belongs to the manager.** `maybeCompact()` owns the provider
 *    connection (`app/compaction-runner.js`), so the command never calls a model itself
 *    and is testable against a stub.
 *  - **a completed compaction restarts the pulse.** Compaction is one of the two moments
 *    the model-call pulse goes back to 0 (`docs/context/call-pulse`); the host loop
 *    resets it after a forced compaction, and a user-driven one is the same event.
 *
 * Like every command it returns a plain result object instead of printing, so the TUI
 * and the line CLI report it identically (`docs/interface/commands`).
 */

/** The one argument this command accepts: compact even within budget. */
export const FORCE_ARG = 'force';

/** A refusal the user can act on: its own code, and a message naming the reason. */
function refuse(code, message) {
  return { ok: false, code, message };
}

/** `/compact [force]` — run a compaction through the live conversation manager. */
export function compactCommand() {
  return {
    name: 'compact',
    description: 'compact the context window now (/compact force to compact within budget)',
    async run(ctx = {}) {
      const { arg = '', manager = null } = ctx;
      const action = String(arg).trim().toLowerCase();

      if (!manager || typeof manager.maybeCompact !== 'function') {
        return refuse('NO_CONTEXT_WINDOW', 'This front end has no context window, so there is nothing to compact.');
      }
      if (action !== '' && action !== FORCE_ARG) {
        return refuse('UNKNOWN_ARG', `Unknown argument "${arg}" for /compact. Use /compact or /compact force.`);
      }

      const force = action === FORCE_ARG;
      let result;
      try {
        result = await manager.maybeCompact(null, { force, reason: 'user-request' });
      } catch (error) {
        return refuse('COMPACTION_FAILED', `The compaction could not run: ${error.message}`);
      }

      // The runner contains a failure and reports it instead of throwing, because a
      // failed compaction must never break the task; here it is the whole answer.
      if (result?.reason === 'error') {
        return refuse(
          'COMPACTION_FAILED',
          `The compaction failed and the window is unchanged: ${result.error ?? 'unknown reason'}.`,
        );
      }

      if (!result?.compacted) {
        return {
          ok: true,
          code: 'WITHIN_BUDGET',
          compacted: false,
          reason: result?.reason ?? 'within-budget',
          usage: result?.usage ?? null,
          message: force
            ? 'Nothing to compact: the window holds no older block to summarise.'
            : 'The context window is still within budget, so nothing was compacted.'
              + ' Use /compact force to compact it anyway.',
        };
      }

      let pulseReset = false;
      if (typeof manager.resetPulse === 'function') {
        manager.resetPulse('compaction');
        pulseReset = true;
      }

      return {
        ok: true,
        code: 'COMPACTED',
        compacted: true,
        olderChunks: Number(result.olderChunks) || 0,
        keptChunks: Number(result.keptChunks) || 0,
        carriedChunks: Number(result.carriedChunks) || 0,
        afterTokens: result.afterTokens ?? null,
        pulseReset,
        usage: result.usage ?? null,
        message: `Context compacted: ${Number(result.olderChunks) || 0} older chunk(s) became one summary,`
          + ` the window is now ${result.usage ?? 'smaller'}.`,
      };
    },
  };
}
