import { nextPrompt } from './message-queue.js';
import { parseCommand, runCommand } from './commands.js';
import { formatCommandResult } from './json-display.js';
import { reloadConversation } from './session-replay.js';

/**
 * The host turn loop, kept out of `main.js` so startup stays wiring.
 *
 * `main.js` builds the pieces (front end, tools, manager, recorder, abort manager)
 * and hands them here; this module owns the only loop in the program: ask for a
 * prompt, answer it if it is a command, otherwise run one turn against the model,
 * and save the conversation once the turn lands.
 *
 * The loop is front-end agnostic — it talks to the `{ question, exit }` surface
 * both `createCLI()` and `createTui()` expose — so the line CLI and the TUI are
 * driven by exactly the same code (`docs/interface/line-cli`).
 *
 * Three behaviours are load-bearing and are proven by `tests/session-loop.test.js`:
 *
 *  - the prompt of every turn comes from `nextPrompt()`, i.e. from the
 *    pending-message queue first and from the front end only when it is empty, and
 *    it is asked *between* turns so an injected message can never split an
 *    assistant `tool_calls` message from its `tool` results;
 *  - `exit` (and the `exit()` sentinel of both front ends) leaves the loop through
 *    one path that saves the session with the `exit` reason;
 *  - an abort ends the current turn quietly — the informational line only — and the
 *    `finally` block always clears the task and stops the spinner.
 */

/** True when the user asked to leave (the `exit` sentinel both front ends emit). */
export function isExitInput(input) {
  return String(input ?? '').trim().toLowerCase() === 'exit';
}

/** True for an abort in any of the shapes the providers and the manager throw. */
export function isAbortError(error) {
  return error?.name === 'AbortError'
    || error?.code === 'ABORTED'
    || String(error?.message ?? '').toLowerCase().includes('aborted');
}

/**
 * Answer one slash command, or return false when the input is a prompt.
 *
 * A command never reaches the model. Resuming a session is the one command with a
 * side effect on the view: the transcript is replaced *before* the result is
 * printed, so the reload cannot wipe the confirmation it belongs with, and the
 * conversation view is rebuilt from the chunks (blocks in the TUI, header + body in
 * the line CLI) — see `docs/interface/session-replay`.
 *
 * @returns {Promise<boolean>} true when the input was consumed as a command
 */
export async function handleCommand(input, {
  commands,
  log = () => {},
  cli = null,
  tui = null,
  manager = null,
  sessions = null,
} = {}) {
  const parsed = parseCommand(input);
  if (!parsed) return false;

  const result = await runCommand(commands, parsed.name, {
    arg: parsed.arg,
    log,
    choose: typeof cli?.choose === 'function' ? (labels, options) => cli.choose(labels, options) : null,
    manager,
    dir: sessions?.dir,
  });

  if (result === null) {
    log(`Unknown command /${parsed.name}. Try /help.`);
    return true;
  }

  if (result.ok && result.code === 'RESUMED') {
    const chunks = result.resumed?.chunks || manager?.chunks || [];
    if (typeof tui?.reload === 'function') tui.reload(chunks);
    else reloadConversation(chunks, { log });

    if (result.resumed?.id && typeof sessions?.adopt === 'function') {
      sessions.adopt(result.resumed.id, {
        createdAt: result.resumed.createdAt,
        model: result.resumed.model,
      });
    }
    for (const line of formatCommandResult(result)) log(line);
    if (result.resumed?.id) {
      log(`[Session] Continuing ${result.resumed.id}; new turns are saved there.`);
    }
    // Repaint the meter from the reloaded window; a front end without one (the
    // line CLI) has nothing to repaint.
    if (typeof tui?.setTokens === 'function') tui.setTokens(manager?.contextWindow?.usage());
    return true;
  }

  for (const line of formatCommandResult(result)) log(line);
  return true;
}

/**
 * Run the session until the user leaves it.
 *
 * @param {object} options
 * @param {object} options.cli the front end (`{ question, exit, choose? }`)
 * @param {object|null} [options.tui] the TUI, when stdout is a TTY
 * @param {Function} options.log the host logger
 * @param {object} options.manager the ConversationManager
 * @param {object} options.commands the slash-command registry
 * @param {object} [options.sessions] the session recorder
 * @param {object} options.abortManager the AbortManager
 * @param {Function} [options.saveSession] called with the reason ('turn'/'exit')
 * @param {Function} [options.onTurnLanded] hook after a successful turn
 * @returns {Promise<'exit'>} how the loop ended
 */
export async function runSessionLoop({
  cli,
  tui = null,
  log = () => {},
  manager,
  commands,
  sessions = null,
  abortManager = null,
  saveSession = () => null,
  onTurnLanded = null,
} = {}) {
  while (true) {
    // Between two turns -- and only there -- the pending-message queue is drained
    // (app/message-queue.js#nextPrompt): a message typed while the last turn was in
    // flight becomes the next prompt. Draining here, and never inside a tool chain,
    // is what keeps an assistant `tool_calls` message together with its results.
    const userInput = await nextPrompt({
      dequeue: () => tui?.dequeue(),
      ask: () => cli.question(tui ? '> ' : '\n> '),
    });

    if (isExitInput(userInput)) {
      log('Exiting...');
      saveSession('exit');
      return 'exit';
    }
    if (!String(userInput ?? '').trim()) continue;

    // A slash command is answered here and never sent to the model.
    const consumed = await handleCommand(userInput, { commands, log, cli, tui, manager, sessions });
    if (consumed) continue;

    abortManager?.startTask();
    try {
      tui?.startSpinner();
      // No repaint after the turn: the manager announces every chunk it adds, so
      // the meter already holds the final number before the spinner stops.
      await manager.processInput(userInput);
      // The turn landed: whatever the provider recovered from on the way is no
      // longer worth showing (main.js drops the retry notice here).
      if (typeof onTurnLanded === 'function') onTurnLanded();
      saveSession('turn');
    } catch (error) {
      if (isAbortError(error)) {
        log('\n[Info] Task was aborted.');
        continue;
      }
      throw error;
    } finally {
      tui?.stopSpinner();
      abortManager?.endTask();
    }
  }
}
