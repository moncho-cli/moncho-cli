import { COMMAND_PALETTE } from '../config/constants.js';
import { runCommand } from '../utils/command-runner.js';
import { defineTool } from '../utils/tool-schema.js';
import {
  windowLines,
  windowCaptured,
  renderCommandOutput,
  CAPTURE_HINT,
  OutputRangeError
} from '../utils/command-output.js';
import { putCapture } from '../utils/capture-store.js';

/**
 * Execute an allow-listed command from a small CLI palette.
 *
 * Hardened relative to the naive `execSync(command)` version: the command line is
 * tokenised in-process and run with `spawn` (utils/command-runner.js), so there is no
 * shell. Shell metacharacters (`;`, `|`, `&&`, backticks, `$(`, redirections, newlines)
 * are rejected outright, and only the first token is checked against the allow-list.
 * That combination is what makes the previous "ls; rm -rf /" style bypass
 * impossible while keeping normal exploration commands working.
 *
 * **The run never blocks.** `execFileSync` stopped the event loop until the child
 * exited, so a child that opened a terminal prompt (a `git` credential ask, an `ssh`
 * password) froze the whole UI — not even Ctrl+C could run, because the handler needs
 * the loop the call had taken. The runner spawns instead, hands the child no terminal
 * and an environment that makes the prompts fail fast, and takes an AbortSignal so
 * cancellation kills the process. A blocked command is now a structured failure with a
 * reason, never a hang.
 *
 * A **successful** command answers as a document (utils/command-output.js): a YAML
 * header, a `---` delimiter, then the stdout. `head`/`tail` window that stdout, so
 * a long listing can be read from either end without a pipe. A **failing** command
 * keeps its JSON diagnostic envelope with a stable `code`, because a machine-
 * readable failure reason matters more than a pretty one; its stdout is windowed
 * the same way.
 */

export class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }
}

/**
 * Split a command line into argv, honouring single and double quotes.
 * @param {string} command
 * @returns {string[]}
 */
export function tokenizeCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new CommandError('EMPTY_COMMAND', 'A non-empty command string is required.');
  }

  const tokens = [];
  let current = '';
  let quote = null;
  let hasCurrent = false;

  for (const char of command) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasCurrent = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasCurrent) {
        tokens.push(current);
        current = '';
        hasCurrent = false;
      }
      continue;
    }
    current += char;
    hasCurrent = true;
  }

  if (quote) throw new CommandError('UNBALANCED_QUOTE', `Unbalanced ${quote} quote in command.`);
  if (hasCurrent) tokens.push(current);
  return tokens;
}

/**
 * Validate a command line and return its argv.
 * @param {string} command
 * @param {string[]} allowList
 * @returns {string[]}
 */
export function validateCommand(command, allowList = COMMAND_PALETTE) {
  const raw = String(command ?? '');

  // Quoted segments are removed before the metacharacter scan so glob patterns in
  // arguments (e.g. "test/**/*.test.js") stay usable, while an unquoted `;`, `|`,
  // `>`, backtick, `$(`, newline or glob is rejected outright.
  const unquoted = raw.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
  const metacharMatch = unquoted.match(/[;&|<>`$(){}[\]\\!\n\r\t*?~]/);
  if (metacharMatch) {
    throw new CommandError(
      'SHELL_METACHARACTER',
      `Command contains a disallowed shell metacharacter ${JSON.stringify(metacharMatch[0])}. Quote glob patterns and run one plain command at a time.`
    );
  }

  const argv = tokenizeCommand(command);
  const binary = argv[0];
  if (!allowList.includes(binary)) {
    throw new CommandError(
      'COMMAND_NOT_ALLOWED',
      `Command '${binary}' is not in the approved list. Approved: ${allowList.join(', ')}.`
    );
  }
  return argv;
}

/** The cwd as the header shows it: `.` when the command ran at the project root. */
export function displayCwd(cwd) {
  const text = String(cwd ?? '');
  return text === process.cwd() ? '.' : text;
}

const { definition, execute } = defineTool({
  name: 'run_bash',
  description:
    'Execute a single allow-listed command (no shell: pipes, chaining and redirection are rejected). A successful command answers a YAML header, a "---" delimiter and then the stdout; use "head" or "tail" to window that stdout instead of piping it.',
  parameters: {
    properties: {
      command: {
        type: 'string',
        description: `The command line to execute. First token must be one of: ${COMMAND_PALETTE.join(', ')}. Quoting is supported; shell metacharacters are not.`
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory (relative path inside the project). Defaults to the project root.'
      },
      timeoutMs: {
        type: 'integer',
        description: 'Optional timeout in milliseconds (default 60000).'
      },
      head: {
        type: 'integer',
        description: 'Show only the first N lines of the output. Mutually exclusive with "tail".'
      },
      tail: {
        type: 'integer',
        description: 'Show only the last N lines of the output. Mutually exclusive with "head".'
      }
    },
    required: ['command']
  },
  async execute(args, ctx = {}) {
    const { resolveProjectPath } = await import('../utils/path-safety.js');

    let argv;
    try {
      argv = validateCommand(args.command);
    } catch (error) {
      return JSON.stringify({ status: 'error', code: error.code, message: error.message });
    }

    const window = { head: args.head, tail: args.tail };
    try {
      windowLines('', window);
    } catch (error) {
      if (error instanceof OutputRangeError) {
        return JSON.stringify({ status: 'error', code: error.code, message: error.message });
      }
      throw error;
    }

    const cwd = args.cwd ? resolveProjectPath(args.cwd) : process.cwd();
    const timeout = Number.isInteger(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 60000;

    const result = await runCommand(argv, { cwd, timeoutMs: timeout, signal: ctx?.signal ?? null });
    if (result.cancelled) {
      return JSON.stringify({
        status: 'error',
        code: 'CANCELLED',
        message: `Command cancelled: ${args.command}`,
        cwd: displayCwd(cwd)
      });
    }
    if (result.spawnError) {
      return JSON.stringify({
        status: 'error',
        code: 'COMMAND_FAILED',
        message: `Command could not start: ${result.spawnError.message}`,
        cwd: displayCwd(cwd)
      });
    }
    if (result.exitCode === 0) {
      return renderSuccess({ command: args.command, cwd, output: result.stdout, window });
    }
    return renderFailure({ result, cwd, window, timeout });
  }
});

/** A successful command: the header, the delimiter, and the stdout window. */
function renderSuccess({ command, cwd, output, window }) {
  const trimmed = output.trimEnd();
  // No window asked for still means a bounded document: a long output comes back as its
  // tail, with the whole stream behind a capture handle (docs/agent/command-capture).
  const selected = windowCaptured(trimmed, window);
  const capture = selected.truncated ? putCapture({ command, text: trimmed }) : null;
  return renderCommandOutput({
    command,
    cwd: displayCwd(cwd),
    exitCode: 0,
    stdout: selected.text,
    total: selected.total,
    shown: selected.shown,
    truncated: selected.truncated,
    mode: selected.mode,
    head: window.head,
    tail: window.tail,
    capture: capture ? capture.id : null,
    range: capture ? shownRange(selected) : null,
    hint: capture ? CAPTURE_HINT : null
  });
}

/** The 1-based line range a window covers, so a captured stream can be paged from it. */
export function shownRange(selected) {
  const total = Number(selected?.total) || 0;
  const shown = Number(selected?.shown) || 0;
  if (shown === 0) return null;
  return selected?.mode === 'head' ? `1-${shown}` : `${total - shown + 1}-${total}`;
}

/**
 * A failing command: the structured envelope the harness relies on, with its stdout
 * windowed so a long failing output is still readable end-first.
 */
function renderFailure({ result, cwd, window, timeout }) {
  const stdout = result.stdout ? String(result.stdout).trimEnd() : '';
  const stderrText = [result.stderr ? String(result.stderr).trimEnd() : '']
    .filter(Boolean)
    .join('\n');
  const stderr = windowCaptured(stderrText, window);
  const selected = windowCaptured(stdout, window);

  if (result.timedOut) {
    return JSON.stringify({
      status: 'error',
      code: 'TIMEOUT',
      message: `Command timed out after ${timeout}ms.`,
      cwd: displayCwd(cwd),
      partialOutput: selected.text,
      stdoutLines: selected.total,
      stdoutShown: selected.shown,
      stdoutTruncated: selected.truncated,
      mode: selected.mode
    });
  }

  return JSON.stringify({
    status: 'error',
    code: 'COMMAND_FAILED',
    message: `Command failed with exit code ${result.exitCode ?? 'unknown'}.`,
    cwd: displayCwd(cwd),
    stdout: selected.text,
    stderr: stderr.text,
    stdoutLines: selected.total,
    stdoutShown: selected.shown,
    stdoutTruncated: selected.truncated,
    stderrLines: stderr.total,
    stderrShown: stderr.shown,
    stderrTruncated: stderr.truncated,
    mode: selected.mode
  });
}

export { definition, execute };
