import { nextPrompt } from './message-queue.js';
import { parseCommand, runCommand } from './commands.js';
import { formatCommandResult } from './json-display.js';
import { reloadConversation } from './session-replay.js';
import { registerSession } from '../utils/host.js';
import { ensureTrackingFiles } from '../utils/tracking-store.js';
import { rememberAppliedSkin, restoreSessionSkin } from './skin-host.js';

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

/**
 * The third source of a prompt: the `work:on` self-drive, or the front end's question.
 *
 * The order is the whole contract of the lock (`docs/interface/modes`): `nextPrompt()`
 * drains the pending-message queue *before* calling this, so a message typed mid-run
 * steers the next turn; when nothing is queued and the lock is engaged, the next
 * `task.md` item becomes the prompt; otherwise the user types.
 *
 * The drive prints its own progress line, so the hand-out is visible without the loop
 * knowing what a checklist is.
 */
export function askForPrompt({ drive = null, cli = null, tui = null } = {}) {
  const next = typeof drive?.next === 'function' ? drive.next() : null;
  if (next && String(next.prompt ?? '').trim()) return next.prompt;
  return cli.question(tui ? '> ' : '\n> ');
}

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
  mode = null,
  // The `/skins prompt` modal subchat (`docs/interface/skins`): the host supplies the
  // function, so a front end without one (the line CLI) refuses with its own code.
  skinSubchat = null,
} = {}) {
  const parsed = parseCommand(input);
  if (!parsed) return false;

  const result = await runCommand(commands, parsed.name, {
    arg: parsed.arg,
    log,
    choose: typeof cli?.choose === 'function' ? (labels, options) => cli.choose(labels, options) : null,
    manager,
    dir: sessions?.dir,
    // The live mode (`app/session-mode.js`), so `/work on|off` moves the very state
    // the gate and the label read. Absent in a front end without modes.
    mode,
    // `/skins` reads the project's skins from its own store and, for `prompt`, opens
    // the modal subchat the host built (`app/skin-modal.js`).
    skinSubchat,
    // After `/skins` moved the palette the chrome has to be re-read: the TUI repaints
    // the border, the brand mark and the live rows in place; the line CLI has no
    // colours to repaint, so it has nothing to do. The applied skin is also remembered
    // as the *project's*, so the next launch opens in it — that is the link between the
    // look and the session, and `applySkin()` has already recorded the name the session
    // save reads (`docs/interface/skins`).
    onApply: (skin) => rememberAppliedSkin(skin, {
      repaint: typeof tui?.repaintTheme === 'function' ? () => tui.repaintTheme() : null,
    }),
  });

  if (result === null) {
    log(`Unknown command /${parsed.name}. Try /help.`);
    return true;
  }

  if (result.ok && result.code === 'RESUMED') {
    // The skin the conversation was held in comes back with it (`docs/interface/skins`).
    // Restoring, not applying: the look the session recorded is what it *was*, exactly like
    // the stored mode. A record written before the field existed carries no skin and leaves
    // the current look alone.
    if (result.resumedSkin) {
      restoreSessionSkin(result.resumedSkin, {
        repaint: typeof tui?.repaintTheme === 'function' ? () => tui.repaintTheme() : null,
      });
    }
    // The stored append times travel with the chunks they belong to
    // (docs/interface/session-stamps): a reloaded row shows when it was written, and a
    // record written before they existed carries one `null` per chunk.
    const stamps = result.resumed?.stamps || [];
    const chunks = result.resumed?.chunks || manager?.chunks || [];
    // The stored intent mode is *restored*, never requested: `/sessions` brings back the
    // state the conversation was left in, and `setMode()` would be refused while a
    // resumed `work:on` lock is on (app/session-mode.js#restore). A file written before
    // the mode existed restores nothing, so the session keeps the state it opened with.
    mode?.restore?.(result.resumedMode);
    if (typeof tui?.reload === 'function') tui.reload(chunks, { stamps });
    else reloadConversation(chunks, { log, stamps });

    if (result.resumed?.id && typeof sessions?.adopt === 'function') {
      sessions.adopt(result.resumed.id, {
        createdAt: result.resumed.createdAt,
        model: result.resumed.model,
      });
      // Register the resumed session with the host so task/plan content is available
      if (result.taskContent !== undefined || result.planContent !== undefined) {
        registerSession(sessions, result.taskContent, result.planContent);
      }
      // Then give the resumed conversation its own pair of tracking files, re-seeded
      // from the record it just carried (utils/tracking-store.js).
      ensureTrackingFiles();
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
  mode = null,
  drive = null,
  skinSubchat = null,
  abortManager = null,
  saveSession = () => null,
  autosave = null,
  onTurnLanded = null,
} = {}) {
  // Every save the loop makes holds the whole window, so it *supersedes* whatever the
  // mid-turn autosave had queued: settling here drops that write instead of repeating
  // it, and restarts the throttle from this save (`app/session-autosave.js`).
  const commit = (reason) => {
    const record = saveSession(reason);
    autosave?.settle?.();
    return record;
  };

  while (true) {
    // Between two turns -- and only there -- the pending-message queue is drained
    // (app/message-queue.js#nextPrompt): a message typed while the last turn was in
    // flight becomes the next prompt. Draining here, and never inside a tool chain,
    // is what keeps an assistant `tool_calls` message together with its results.
    const userInput = await nextPrompt({
      dequeue: () => tui?.dequeue(),
      // The keyboard is the *third* source of a prompt: the queue is drained first, and
      // while `work:on` the self-drive (app/work-drive.js) hands over the next task.md
      // item, so the session keeps walking the checklist in its own conversation instead
      // of waiting for a keystroke. A typed message still wins, which is what makes live
      // steering work.
      ask: () => askForPrompt({ drive, cli, tui }),
    });

    if (isExitInput(userInput)) {
      log('Exiting...');
      commit('exit');
      return 'exit';
    }
    if (!String(userInput ?? '').trim()) continue;

    // A slash command is answered here and never sent to the model.
    const consumed = await handleCommand(userInput, { commands, log, cli, tui, manager, sessions, mode, skinSubchat });
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
      commit('turn');
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