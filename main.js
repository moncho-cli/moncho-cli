import { loadTools } from './utils/tool-loader.js';
import { nextPrompt } from './app/message-queue.js';
import { ConversationManager } from './app/conversation-manager.js';
import { createCLI } from './app/cli.js';
import { createTui } from './app/tui.js';
import { AbortManager } from './app/abort-manager.js';
import { createSessionRecorder } from './app/session-recorder.js';
import { createDefaultCommands, parseCommand, runCommand } from './app/commands.js';
import { prettyPrintJson, formatCommandResult } from './app/json-display.js';
import { formatUserEcho } from './app/tui-render.js';
import { reloadConversation } from './app/session-replay.js';
import {
  CONTEXT_MAX_LENGTH_OVERRIDE, BASE_URL, API_KEY, MODEL, describeModel,
} from './config/constants.js';
import { resolveContextSize, formatContextLimit } from './utils/context-size.js';

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
    // A JSON result is re-indented for display only (task.md item 5): the model
    // still receives the raw bytes, and the session file keeps them verbatim.
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

  // The conversation is recorded under agent/sessions/<date>.json (task.md item
  // 3): every chunk of the live window, verbatim, so it can be picked up later.
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

  // Slash commands (task.md item 4): an iterable registry, so adding a command
  // later needs no change in this loop. Anything that is not `/<name>` stays a
  // prompt and goes to the model untouched.
  const commands = createDefaultCommands();
  const handleCommand = async (input) => {
    const parsed = parseCommand(input);
    if (!parsed) return false;
    const result = await runCommand(commands, parsed.name, {
      arg: parsed.arg,
      log,
      choose: typeof cli.choose === 'function' ? (labels, options) => cli.choose(labels, options) : null,
      manager,
      dir: sessions.dir,
    });
    if (result === null) {
      log(`Unknown command /${parsed.name}. Try /help.`);
      return true;
    }
    if (result.ok && result.code === 'RESUMED') {
      // The reload empties the transcript, so it runs before the result is
      // printed: otherwise it would wipe the confirmation it belongs with. And
      // the conversation *view* is reloaded, not just the context: the chunks
      // hold the whole dialogue, so the transcript is rebuilt from them — in the
      // TUI as collapsible blocks, in the line CLI as header, body, blank.
      const chunks = result.resumed?.chunks || manager.chunks;
      if (typeof tui?.reload === 'function') tui.reload(chunks);
      else reloadConversation(chunks, { log });
      // Keep saving into the session that was opened, instead of starting a
      // parallel file: resuming must continue the conversation.
      if (result.resumed?.id) {
        sessions.adopt(result.resumed.id, {
          createdAt: result.resumed.createdAt,
          model: result.resumed.model,
        });
      }
      for (const line of formatCommandResult(result)) log(line);
      if (result.resumed?.id) {
        log(`[Session] Continuing ${result.resumed.id}; new turns are saved there.`);
      }
      tui?.setTokens(manager.contextWindow.usage());
      saveSession('resume');
      return true;
    }
    for (const line of formatCommandResult(result)) log(line);
    return true;
  };

  tui?.setTokens(manager.contextWindow.usage());
  log(`\nProvider/model: ${label}`);
  log(`Session file: ${sessions.path} (saved after every turn)`);
  log(`Context window budget: ${formatContextLimit(contextSize)} tokens (compaction keeps the newest 20%)`);

  log("\nChat initialized. Type 'exit' to quit.");
  log("ESC or Ctrl+C cancels a running task (press twice to confirm) and quits when idle.");
  log(`Commands: ${commands.list().map((command) => `/${command.name}`).join(', ')} (try /help)`);

  while (true) {
    // Between two turns -- and only there -- the pending-message queue is drained
    // (app/message-queue.js#nextPrompt): a message typed while the last turn was in
    // flight becomes the next prompt instead of waiting for the user to type it
    // again (task.md: "injected when possible"). Draining here, and never inside a
    // tool chain, is what keeps an assistant `tool_calls` message together with its
    // `tool` results. The line CLI has no queue bar, so `tui` is null there and
    // readline buffers the typed line for the next question() exactly as before.
    const userInput = await nextPrompt({
      dequeue: () => tui?.dequeue(),
      ask: () => cli.question(tui ? '> ' : '\n> '),
    });

    if (userInput.toLowerCase() === 'exit') {
      log("Exiting...");
      saveSession('exit');
      break;
    }
    if (!userInput.trim()) continue;

    // A slash command is answered here and never sent to the model.
    if (await handleCommand(userInput)) continue;

    abortManager.startTask();
    try {
      tui?.startSpinner();
      // No repaint after the turn: the manager announces every chunk it adds
      // (app/conversation-manager.js#ConversationManager), so the meter already
      // holds the final number before the spinner stops.
      await manager.processInput(userInput);
      // The turn landed, so whatever the provider recovered from on the way is no
      // longer worth showing: drop the retry notice now rather than at its TTL.
      if (retryNotice !== null) {
        tui?.dismissNotice(retryNotice);
        retryNotice = null;
      }
      saveSession('turn');
    } catch (error) {
      if (
        error.name === 'AbortError' ||
        error.code === 'ABORTED' ||
        error.message?.toLowerCase().includes('aborted')
      ) {
        log('\n[Info] Task was aborted.');
        continue;
      }
      throw error;
    } finally {
      tui?.stopSpinner();
      abortManager.endTask();
    }
  }

  abortManager.dispose();
  cli.close();
}

main().catch((error) => {
  if (activeTui) activeTui.close();
  console.error(error);
  process.exitCode = 1;
});
