import { loadTools } from './utils/tool-loader.js';
import { ConversationManager } from './app/conversation-manager.js';
import { createCLI } from './app/cli.js';
import { createTui } from './app/tui.js';
import { AbortManager } from './app/abort-manager.js';
import { createSessionSave } from './app/session-save.js';
import { createDefaultCommands } from './app/commands.js';
import { createSkinSubchat } from './app/skin-subchat.js';
import { createSkinProposer } from './app/skin-prompt.js';
import { applyProjectSkin, currentSkin } from './app/skin-host.js';
import { callOllama } from './api/ollama.js';
import { createSessionMode } from './app/session-mode.js';
import { toolsForMode, gateForMode } from './app/mode-policy.js';
import { createModeController } from './app/mode-controller.js';
import { createNoticeSink } from './app/notice-sink.js';
import { createToolEcho } from './app/tool-echo.js';
import { formatUserEcho } from './app/tui-render.js';
import { runSessionLoop, handleCommand } from './app/session-loop.js';
import { createWorkDrive } from './app/work-drive.js';
import { createBusyCommandRunner } from './app/busy-command.js';
import { registerSession, registerTrackingNotifier, registerCollapseNotifier, registerLogger } from './utils/host.js';
import { createLogger, logEvent } from './utils/logger.js';
import { createTrackingAnnouncer } from './app/tracking-block.js';
import { createCollapseNotifier } from './app/collapse-notice.js';
import {
  CONTEXT_MAX_LENGTH_OVERRIDE, BASE_URL, API_KEY, MODEL, describeModel,
  APPROACH_MAX_REFUSALS,
} from './config/constants.js';
import { ensureTrackingFiles } from './utils/tracking-store.js';
import { resolveContextSize, formatContextLimit } from './utils/context-size.js';
import { describeCompactionSplit } from './utils/compaction.js';

/**
 * Startup wiring.
 *
 * This module only *builds* the session — front end, tools, manager, recorder,
 * commands — and then hands the built pieces to `app/session-loop.js`, which owns
 * the one loop in the program. Keeping the wiring and the loop apart is what lets
 * the loop be tested without a terminal or a provider, and what keeps this file
 * under the line budget as the session surface grows (see
 * `docs/runtime/startup-wiring`).
 */

// The operational log (utils/logger.js, docs/runtime/logging) is built once, at
// module scope, and registered in the host registry before the session is wired: a
// startup failure then lands in the log too, which is exactly the failure an
// operator has no other record of. The deep modules (api/ollama.js,
// app/turn-runner.js, app/tool-batch.js) record what the harness *did* through
// `logEvent()`, so they never hold a logger they have no other use for.
// `LOG_LEVEL`, `LOG_FILE`, `LOG_MAX_BYTES` and `LOG_MAX_FILES` come from the
// environment; with no logger registered `logEvent()` is a silent no-op, which is
// what keeps the test suites free of side effects.
const logger = registerLogger(createLogger());

let activeTui = null;

async function main() {
  // The provider/model label is read from the environment (OPENAI_BASE_URL /
  // OPENAI_MODEL) once at startup and shown in the TUI model row.
  const { label } = describeModel();
  const contextSize = await resolveContextSize({
    configured: CONTEXT_MAX_LENGTH_OVERRIDE,
    baseUrl: BASE_URL,
    model: MODEL,
    apiKey: API_KEY,
  });

  // A pty gives us the full TUI; a detached run (`./start.sh start`) has no TTY,
  // so createTui() returns null and we keep the line-based chat.
  // The interrupt hook is late-bound: the TUI is built before the AbortManager
  // exists, and Escape / Ctrl+C are forwarded to it once it is created below.
  let abortManager = null;
  // The session's intent mode (app/session-mode.js) is the one piece of state that
  // decides what may touch a file, so the TUI paints it and Tab walks it. Both hooks
  // are late-bound: the key only reports a direction, and app/mode-controller.js turns
  // that into a cycle() plus a routed refusal, which needs the notice sink built below.
  const sessionMode = createSessionMode();
  let modeController = null;
  // Slash commands: an iterable registry, so adding a command later needs no change in
  // the loop. Anything that is not `/<name>` stays a prompt. Built **before** the screen
  // because the input box's completion popup reads it live on every keystroke
  // (app/slash-menu.js), and handed over as a function rather than a list so the popup
  // can never hold commands that were registered later.
  const commands = createDefaultCommands();

  // The project's skin (`docs/interface/skins`), applied before the screen is built so
  // the first frame already wears it, plus the bootstrap mark that lets a resumed session
  // restore its own look afterwards (app/skin-host.js).
  const activeSkin = applyProjectSkin();
  const tui = createTui({
    modelLabel: label,
    mode: sessionMode,
    onInterrupt: () => abortManager?.interrupt(),
    onCycleMode: (options) => modeController?.cycle(options),
    commands: () => commands.list(),
  });
  activeTui = tui;
  const cli = tui || createCLI();
  const log = tui ? (...args) => tui.log(...args) : (...args) => console.log(...args);

  logger.info('startup', `moncho ${label} starting; log threshold ${logger.level}`, {
    file: logger.file,
    maxBytes: logger.maxBytes,
    maxFiles: logger.maxFiles,
  });

  // Transient notices (`app/notice-sink.js`): a retried provider failure is *news*, not
  // history, so it floats over the transcript and hides itself after a few minutes
  // instead of leaving a stale error line in the record. The same object keeps the retry
  // handle so a turn that finally succeeds can take it down at once.
  const { notify, dismissRetry } = createNoticeSink({ tui, log });

  // The refusal route for `Tab` (app/mode-controller.js): the sink above is the only
  // thing left to plug in, so the cycle hook the TUI was built with can be armed now.
  // A refused cycle is *news* — it goes to the notice bar (or one plain line) and
  // never to the transcript, exactly like a recovered provider failure.
  modeController = createModeController({
    mode: sessionMode,
    notify: (kind, text) => notify(kind, text),
  });
  log("Initializing tools...");

  // Tool results are echoed to the screen (with the call's intent) and also returned to
  // the model (`app/tool-echo.js`): a collapsible block in the TUI, plain lines in the CLI.
  const onToolResult = createToolEcho({ tui, log });

  const { tools, toolFunctions } = await loadTools(onToolResult);
  log(`Loaded ${tools.length} tools:`, tools.map(t => t.function.name).join(', '));

  // When the TUI owns stdin (blessed reads it directly) the AbortManager must
  // not install its own keypress listener, otherwise every keystroke is
  // delivered twice. The TUI forwards Esc/Ctrl+C to us instead.
  abortManager = new AbortManager(cli.rl, {
    captureKeys: !tui,
    confirmMode: tui ? 'keys' : 'prompt',
    onExit: () => cli.exit(),
    log,
  });

  // Half 1 of the mode policy (app/mode-policy.js): the provider is only offered the
  // tools the mode allows, so a read-only session is never *invited* to write.
  const getTools = () => toolsForMode(sessionMode.mode, tools);
  const getAbortSignal = () => abortManager.signal;
  // The mid-turn session autosave (app/session-autosave.js), late-bound like the other
  // hooks because it writes *through* `saveSession`, which snapshots the manager: a
  // chunk change can only happen once both exist.
  let autosave = null;
  const manager = new ConversationManager(toolFunctions, getTools, getAbortSignal, {
    log,
    // The model label is the key the per-model usage table is kept under.
    model: label,
    maxTokens: contextSize.maxTokens,
    configuredTokens: contextSize.configuredTokens,
    realTokens: contextSize.realTokens,
    contextSizeSource: contextSize.source,
    // The user's own message is echoed into the conversation view too, so the
    // transcript reads as a dialogue; the chunk the model receives is untouched
    // (app/tui-render.js#formatUserEcho is display only).
    onUserMessage: (text) => log(formatUserEcho(text)),
    // The same echo on the prose route, which the TUI bands (docs/interface/prose-bands).
    onProse: tui ? (role, text) => tui.logProse(role, text) : null,
    // Recovered failures go to the overlay, never to the transcript.
    onNotice: (kind, text, options) => notify(kind, text, options),
    // Half 2 of the mode policy: every call still passes the pre-dispatch gate
    // (app/tool-guard.js), so a call named from an older prompt is refused instead of
    // touching anything. The mode is read live, so a Tab mid-turn bites at once.
    toolGate: gateForMode({ getMode: () => ({ mode: sessionMode.mode, work: sessionMode.work }) }),
    // The approach rule (docs/agent/approach-gate): the stated approach seeds the turn —
    // one short statement of intent, then as much work as the task needs. The bound is
    // what keeps a model that will not speak from deadlocking the turn — after this many
    // refusals the batch runs and the skip is announced — and it comes from
    // `APPROACH_MAX_REFUSALS`.
    approachMaxRefusals: APPROACH_MAX_REFUSALS,
    // The record follows the conversation, not the turn (app/session-autosave.js):
    // the first chunk of a turn writes it at once, and a burst of chunks in one tick
    // is coalesced into the next write instead of one write per chunk.
    onChunksChange: (reason) => autosave?.touch(reason),
    onContextChange: (stats) => {
      tui?.setTokens(stats.usage);
      tui?.notifyCompaction(stats);
    },
  });

  // The working-time row (app/work-row.js) is painted from the clock, not from the
  // window: the clock emits once a second while a span is open, so the counter
  // climbs while the model is thinking instead of jumping when the call lands. It
  // is host state and never a chunk, so nothing here reaches the provider
  // (docs/context/working-time).
  const paintWork = () => tui?.setWork(manager.workingTotals());
  manager.working.subscribe(paintWork);
  paintWork();

  // The conversation is recorded in agent/sessions/<id>/context.json — the record
  // inside the conversation's own folder: every chunk of the live window, verbatim,
  // so it can be picked up later (`/sessions`, docs/runtime/session-store).
  // `stateOf` and `skinOf` are read on every save, so the intent mode, the `work:on`
  // lock and the look travel with the conversation and a resumed session opens in the
  // state and colours it was left in (docs/interface/modes, docs/interface/skins).
  const record = createSessionSave({
    manager,
    model: label,
    stateOf: () => sessionMode.toJSON(),
    skinOf: () => currentSkin(),
    logger,
    log,
  });
  const sessions = record.sessions;
  const saveSession = record.saveSession;
  autosave = record.autosave;

  // Register the session, then give its folder the two tracking files it owns
  // (agent/sessions/<id>/task.md and implementation_plan.md, docs/agent/task-tracking).
  // A fresh session inherits a root `task.md` when there is one, so an operator with a
  // checklist in the tree keeps working; the bytes written are canonical.
  registerSession(sessions);
  ensureTrackingFiles();

  // A tracking update is announced twice, both in the palette's own contrasting colour
  // (app/tracking-block.js): the `[Tracking]` rows say *what happened* ("item X done",
  // "plan reset for Y") and a titled block shows *what the files now hold* — their full
  // content (docs/interface/tracking-block). The block is TUI only: with no `logBlock`
  // the line CLI keeps just the rows. The tool reports the update via utils/host.js.
  registerTrackingNotifier(createTrackingAnnouncer({
    log,
    logBlock: tui ? (block) => tui.logBlock(block) : null,
  }));

  // A collapse is announced the way a compaction is — one `[Context]` row — so the window
  // shrinking when an item is solved is explained rather than mysterious
  // (app/collapse-notice.js, docs/interface/collapse-notice). One line, not a start/end
  // pair: the rewrite is synchronous, so there is no gap for a start line to fill. The
  // runner reports it via utils/host.js, and a bare tool call (no sink) stays silent.
  registerCollapseNotifier(createCollapseNotifier({ log }));

  // The mid-turn throttle (app/session-autosave.js) starts now, once `saveSession`
  // exists: the conversation is written as it happens — the first chunk of a turn at
  // once, a burst of chunks coalesced — instead of only when a turn ends. The loop still
  // saves after every turn and on exit, and it settles this throttle then, because that
  // save already holds the whole window.
  record.autosave.start();

  // The `work:on` self-drive (app/work-drive.js): while the lock is on, the next prompt
  // comes from `task.md` instead of the keyboard. It reads the mode live, so a `/work on`
  // typed mid-session starts driving on the very next turn and `/work off` stops it — no
  // restart and no second conversation.
  const drive = createWorkDrive({ mode: sessionMode, log });

  // Mid-turn commands (app/busy-command.js): a slash command typed while a turn runs is
  // not a message for the model, so it must not enter the pending-message queue. A
  // read-only one (`/help`, `/usage`, `/task`) is answered at once — it runs through the
  // same `handleCommand()` the loop uses, so it behaves exactly as it would between
  // turns — and a command that mutates the conversation is refused with a notice, because
  // running it underneath a live turn would corrupt the window that turn is appending to.
  // Installed here because the handler needs everything above: the registry, the manager,
  // the picker and the notice sink. A front end without an input box (the line CLI) has
  // nothing to install into and is unchanged.
  // `/skins prompt` reaches the modal subchat through this one function: the model
  // call is a proposer over the live provider (`app/skin-prompt.js`), and the TUI
  // puts the proposal in a modal (`app/skin-modal.js`). With no TUI the subchat is
  // absent and `/skins prompt` refuses with its own code, leaving the look alone.
  //
  // It is **declared here**, not passed inline below, because two closures need it: the
  // loop's context *and* the mid-turn command runner installed just above
  // (`app/busy-command.js`). Naming it as an object property at the call site does not
  // create a binding in scope, so the runner's `run` closure reached an undeclared
  // identifier and every mid-turn `/task` failed with
  // `ReferenceError: skinSubchat is not defined` — a red notice for a command that was
  // not actually broken.
  const skinSubchat = tui
    ? createSkinSubchat({
      screen: tui.screen,
      inputBox: tui.inputBox,
      refresh: tui.refresh,
      proposer: createSkinProposer({
        callModel: (messages, ctx) => callOllama(messages, [], false, ctx?.signal, { systemPrompt: false }),
      }),
    })
    : null;

  tui?.setBusySubmit?.(createBusyCommandRunner({
    registry: commands,
    run: (input) => handleCommand(input, { commands, log, cli, tui, manager, sessions, mode: sessionMode, skinSubchat, contentView: tui ? (view) => tui.contentView(view) : null }),
    notify: (kind, text) => notify(kind, text),
  }));

  tui?.setTokens(manager.contextWindow.usage());
  log(`\nProvider/model: ${label}`);
  log(`Session file: ${sessions.path} (saved after every turn)`);
  log(`Context window budget: ${formatContextLimit(contextSize)} tokens (compaction keeps the newest ${describeCompactionSplit().keepLabel} and the last user message)`);

  log("\nChat initialized. Type 'exit' to quit.");
  log("ESC or Ctrl+C cancels a running task (press twice to confirm) and quits when idle.");
  log(`Commands: ${commands.list().map((command) => `/${command.name}`).join(', ')} (try /help)`);
  if (activeSkin && activeSkin.name !== 'default') log(`Skin: ${activeSkin.name} (change it with /skins)`);

  await runSessionLoop({
    cli,
    tui,
    log,
    manager,
    commands,
    sessions,
    mode: sessionMode,
    drive,
    // `/skins prompt` reaches the modal subchat (declared above, where the mid-turn
    // command runner needs it too). With no TUI it is null and `/skins prompt` refuses
    // with its own code, leaving the look alone.
    skinSubchat,
    // `/task` opens the read-only viewer when there is a screen; without one the command
    // returns the documents as lines and the host prints them.
    contentView: tui ? (view) => tui.contentView(view) : null,
    abortManager,
    saveSession,
    autosave,
    // The turn landed, so whatever the provider recovered from on the way is no
    // longer worth showing: drop the retry notice now rather than at its TTL.
    onTurnLanded: () => dismissRetry(),
  });

  abortManager.dispose();
  // The loop is over, so nothing is left for the mid-turn throttle to write: closing it
  // also cancels a trailing timer that would otherwise fire into a closed session.
  autosave?.close();
  cli.close();
}

main().catch((error) => {
  logEvent('error', 'startup', 'fatal error; the session could not start', error);
  if (activeTui) activeTui.close();
  console.error(error);
  process.exitCode = 1;
});