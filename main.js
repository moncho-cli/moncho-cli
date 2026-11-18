import { loadTools } from './utils/tool-loader.js';
import { ConversationManager } from './app/conversation-manager.js';
import { createCLI } from './app/cli.js';
import { createTui } from './app/tui.js';
import { AbortManager } from './app/abort-manager.js';
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

  log("Initializing tools...");

  // Tool results are echoed to the screen (with the call's intent) and also
  // returned to the model.
  const onToolResult = (toolName, result, intent) => {
    log(`\n  [${toolName} Output]${intent ? ` (intent: ${intent})` : ''}`);
    log(result);
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
    maxTokens: contextSize.maxTokens,
    configuredTokens: contextSize.configuredTokens,
    realTokens: contextSize.realTokens,
    contextSizeSource: contextSize.source,
    onContextChange: (stats) => {
      tui?.setTokens(stats.usage);
      tui?.notifyCompaction(stats);
    },
  });

  tui?.setTokens(manager.contextWindow.usage());
  log(`\nProvider/model: ${label}`);
  log(`Context window budget: ${formatContextLimit(contextSize)} tokens (compaction keeps the newest 20%)`);

  log("\nChat initialized. Type 'exit' to quit.");
  log("ESC or Ctrl+C cancels a running task (press twice to confirm) and quits when idle.");

  while (true) {
    const userInput = await cli.question(tui ? '> ' : '\n> ');

    if (userInput.toLowerCase() === 'exit') {
      log("Exiting...");
      break;
    }
    if (!userInput.trim()) continue;

    abortManager.startTask();
    try {
      tui?.startSpinner();
      await manager.processInput(userInput);
      tui?.setTokens(manager.contextWindow.usage());
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
