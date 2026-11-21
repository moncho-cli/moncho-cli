/**
 * `/new` — start a fresh conversation without leaving the process.
 *
 * A session is one conversation, its own folder and its own pair of tracking files, and
 * until now the only way to get a *new* one was to quit and start again. This command is
 * the literal `/new`: it empties the live window and hands the host a report that makes it
 * rotate the session identity, re-seed the checklist and reset the view — so the next turn
 * is saved into a brand-new conversation.
 *
 * Three decisions are worth naming:
 *
 *  - **the old conversation is left on disk, never deleted.** The host saves after every
 *    turn, so by the time a command runs the previous conversation is already written;
 *    `/new` starts a second one beside it, and `/sessions` still lists the first.
 *  - **the command moves the manager state it owns, nothing more.**
 *    `ConversationManager#contextWindow` and `#usage` are the live window and the live
 *    accounting table, so clearing them here is what makes the reset real; the session id,
 *    the view and the mode belong to the host, which rotates them from the result.
 *  - **it takes no argument.** `/new` is an action, not a switch; anything after it is a
 *    typo, and a typo that silently reset the conversation would be a bad trade.
 *
 * Like every command it returns a plain result object instead of printing, so the TUI and
 * the line CLI report it identically (`docs/interface/commands`).
 */

/** A refusal the user can act on: its own code, and a message naming the reason. */
function refuse(code, message) {
  return { ok: false, code, message };
}

/** `/new` — empty the live conversation and start a fresh session. */
export function newCommand() {
  return {
    name: 'new',
    description: 'start a new session (the current conversation stays on disk for /sessions)',
    run(ctx = {}) {
      const { arg = '', manager = null } = ctx;

      if (!manager || typeof manager.contextWindow?.clear !== 'function') {
        return refuse('NO_CONTEXT_WINDOW', 'This front end has no context window, so there is no session to start.');
      }
      if (String(arg).trim() !== '') {
        return refuse('UNKNOWN_ARG', `Unknown argument "${arg}" for /new. Use /new on its own.`);
      }

      // The window and the journal together are the conversation, so `clear()` empties
      // both (app/context-window.js); the accounting table and the call pulse describe
      // *this* conversation too, so a fresh one starts them from zero.
      manager.contextWindow.clear();
      if (typeof manager.usage?.reset === 'function') manager.usage.reset();
      if (typeof manager.resetPulse === 'function') manager.resetPulse('new-session');

      return {
        ok: true,
        code: 'NEW_SESSION',
        message: 'Started a new session. The previous conversation stays on disk; /sessions lists it.',
      };
    },
  };
}
