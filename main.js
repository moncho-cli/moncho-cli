import { loadTools } from './utils/tool-loader.js';
import { ConversationManager } from './app/conversation-manager.js';
import { createCLI } from './app/cli.js';
import { createTui } from './app/tui.js';
import { AbortManager } from './app/abort-manager.js';
import { createSessionRecorder } from './app/session-recorder.js';
import { createDefaultCommands } from './app/commands.js';
import { prettyPrintJson } from './app/json-display.js';
import { formatUserEcho } from './app/tui-render.js';
import { runSessionLoop } from './app/session-loop.js';
import {
  CONTEXT_MAX_LENGTH_OVERRIDE, BASE_URL, API_KEY, MODEL, describeModel,
} from './config/constants.js';
import { resolveContextSize, formatContextLimit } from './utils/context-size.js';

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
  const tui = createTui({ modelLabel: label, onInterrupt: () => abortManager?.interrupt() });
  activeTui = tui;
  const cli = tui || createCLI();
  const log = tui ? (...args) => tui.log(...args) : (...args) => console.log(...args);

  // Transient notices (app/notice-overlay.js): a retried provider failure is *news*,
  // not history, so it floats over the top of the transcript and hides itself after
  // a few minutes instead of leaving a stale error line behind. The line CLI has no
  // floating box, so it prints the notice as a plain line — the information is the
  // same, only the place differs (docs/interface/line-cli).
  // The handle of the current retry notice is kept so a turn that finally succeeds
  // can take it down at once instead of waiting out its TTL.
  let retryNotice = null;
  const notify = (kind, text, options = {}) => {
    if (tui) {
      const handle = tui.notice(kind, text, options);
      if (options.code === 'retry') retryNotice = handle;
      return handle;
    }
    log(`[${kind}] ${text}`);
    return null;
  };

  log("Initializing tools...");

  // Tool results are echoed to the screen (with the call's intent) and also
  // returned to the model.
  const onToolResult = (toolName, result, intent) => {
    // In the TUI a tool result is a collapsible block: one header line carrying
    // the "X char response" size, expanded with a click. The line CLI has no
    // widget, so it prints the header and the payload plainly.
    // A JSON result is re-indented for display only: the model still receives the
    // raw bytes, and the session file keeps them verbatim.
    const body = prettyPrintJson(result);
    const header = `\n  [${toolName} Output]${intent ? ` (intent: ${intent})` : ''}`;
    if (tui) {
      tui.logBlock({ header, body });
      return;
    }
    log(header);
    log(body);
    log();
  };

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

  const getTools = () => tools;
  const getAbortSignal = () => abortManager.signal;
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
    // Recovered failures go to the overlay, never to the transcript.
    onNotice: (kind, text, options) => notify(kind, text, options),
    onContextChange: (stats) => {
      tui?.setTokens(stats.usage);
      tui?.notifyCompaction(stats);
    },
  });

  // The conversation is recorded under agent/sessions/<date>.json: every chunk of
  // the live window, verbatim, so it can be picked up later (`/sessions`).
  const sessions = createSessionRecorder({ model: label });
  const saveSession = (reason) => {
    try {
      return sessions.save(manager.chunks, {
        reason,
        stats: manager.contextWindow.stats(),
        // What each model consumed so far, so the session file is the accounting
        // record and `/usage` survives a restart.
        usage: manager.usageTable(),
      });
    } catch (error) {
      log(`\n[Session] Could not save ${sessions.path}: ${error.message}`);
      return null;
    }
  };

  // Slash commands: an iterable registry, so adding a command later needs no
  // change in the loop. Anything that is not `/<name>` stays a prompt.
  const commands = createDefaultCommands();

  tui?.setTokens(manager.contextWindow.usage());
  log(`\nProvider/model: ${label}`);
  log(`Session file: ${sessions.path} (saved after every turn)`);
  log(`Context window budget: ${formatContextLimit(contextSize)} tokens (compaction keeps the newest 20%)`);

  log("\nChat initialized. Type 'exit' to quit.");
  log("ESC or Ctrl+C cancels a running task (press twice to confirm) and quits when idle.");
  log(`Commands: ${commands.list().map((command) => `/${command.name}`).join(', ')} (try /help)`);

  await runSessionLoop({
    cli,
    tui,
    log,
    manager,
    commands,
    sessions,
    abortManager,
    saveSession,
    // The turn landed, so whatever the provider recovered from on the way is no
    // longer worth showing: drop the retry notice now rather than at its TTL.
    onTurnLanded: () => {
      if (retryNotice !== null) {
        tui?.dismissNotice(retryNotice);
        retryNotice = null;
      }
    },
  });

  abortManager.dispose();
  cli.close();
}

main().catch((error) => {
  if (activeTui) activeTui.close();
  console.error(error);
  process.exitCode = 1;
});
