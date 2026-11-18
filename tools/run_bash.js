import { execFileSync } from 'child_process';
import { ALLOWED_COMMANDS } from '../config/constants.js';
import { defineTool } from '../utils/tool-schema.js';

/**
 * Execute an allow-listed command from a small CLI palette.
 *
 * Hardened relative to the naive `execSync(command)` version: the command line is
 * tokenised in-process and run with execFileSync, so there is no shell. Shell
 * metacharacters (`;`, `|`, `&&`, backticks, `$(`, redirections, newlines) are
 * rejected outright, and only the first token is checked against the allow-list.
 * That combination is what makes the previous "ls; rm -rf /" style bypass
 * impossible while keeping normal exploration commands working.
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
export function validateCommand(command, allowList = ALLOWED_COMMANDS) {
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

const { definition, execute } = defineTool({
  name: 'run_bash',
  description: 'Execute a single allow-listed command (no shell: pipes, chaining and redirection are rejected).',
  parameters: {
    properties: {
      command: {
        type: 'string',
        description: `The command line to execute. First token must be one of: ${ALLOWED_COMMANDS.join(', ')}. Quoting is supported; shell metacharacters are not.`
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory (relative path inside the project). Defaults to the project root.'
      },
      timeoutMs: {
        type: 'integer',
        description: 'Optional timeout in milliseconds (default 60000).'
      }
    },
    required: ['command']
  },
  async execute(args) {
    const { resolveProjectPath } = await import('../utils/path-safety.js');

    let argv;
    try {
      argv = validateCommand(args.command);
    } catch (error) {
      return JSON.stringify({ status: 'error', code: error.code, message: error.message });
    }

    const cwd = args.cwd ? resolveProjectPath(args.cwd) : process.cwd();
    const timeout = Number.isInteger(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 60000;

    try {
      const stdout = execFileSync(argv[0], argv.slice(1), {
        cwd,
        timeout,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const output = typeof stdout === 'string' ? stdout : String(stdout ?? '');
      return output.trimEnd() || '(no output)';
    } catch (error) {
      const stderr = error.stderr ? String(error.stderr).trimEnd() : '';
      const stdout = error.stdout ? String(error.stdout).trimEnd() : '';
      if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
        return JSON.stringify({ status: 'error', code: 'TIMEOUT', message: `Command timed out after ${timeout}ms.`, partialOutput: stdout });
      }
      return JSON.stringify({
        status: 'error',
        code: 'COMMAND_FAILED',
        message: `Command failed with exit code ${error.status ?? 'unknown'}.`,
        stdout,
        stderr
      });
    }
  }
});

export { definition, execute };
