import { execFile } from 'child_process';
import {
  NPM_ALLOWED_SUBCOMMANDS,
  NPM_DEFAULT_TIMEOUT_MS,
  NPM_MAX_TIMEOUT_MS
} from '../config/constants.js';
import { resolveProjectPath } from '../utils/path-safety.js';
import { defineTool } from '../utils/tool-schema.js';

/**
 * npm runner for the harness.
 *
 * `run_bash` intentionally exposes only a tiny, shell-free CLI palette, so it
 * cannot install the dependency a TUI needs. `run_npm` closes that gap without
 * opening a shell: arguments are passed to the `npm` binary as argv (no shell
 * interpolation, so package names cannot inject commands), and only an
 * allow-listed set of subcommands is accepted.
 */

export class NpmError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NpmError';
    this.code = code;
  }
}

/** Packages/args that would touch files outside the project. */
const FORBIDDEN_ARG = /^(--prefix=|--global$|-g$|--location=global$)/;

/**
 * Validate npm argv (without the leading `npm`) and return it unchanged.
 * @param {string[]|string} args
 * @returns {string[]}
 */
export function validateNpmArgs(args) {
  const argv = Array.isArray(args) ? args.map(String) : splitNpmArgs(args);

  if (argv.length === 0) {
    throw new NpmError('EMPTY_ARGS', 'At least an npm subcommand is required (e.g. ["install", "neo-blessed"]).');
  }

  const subcommand = argv[0];
  if (!NPM_ALLOWED_SUBCOMMANDS.includes(subcommand)) {
    throw new NpmError(
      'SUBCOMMAND_NOT_ALLOWED',
      `npm ${subcommand} is not allowed. Allowed subcommands: ${NPM_ALLOWED_SUBCOMMANDS.join(', ')}.`
    );
  }

  for (const token of argv) {
    if (/[;&|<>`$\n\r\t]/.test(token)) {
      throw new NpmError('SHELL_METACHARACTER', `Argument ${JSON.stringify(token)} contains a shell metacharacter.`);
    }
    if (FORBIDDEN_ARG.test(token)) {
      throw new NpmError('ARG_NOT_ALLOWED', `Argument ${JSON.stringify(token)} is not allowed (installs must stay inside the project).`);
    }
  }

  return argv;
}

/** Split a raw command string into argv without invoking a shell. */
export function splitNpmArgs(input) {
  const text = String(input ?? '').trim();
  if (text === '') return [];
  return text.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
}

const { definition, execute } = defineTool({
  name: 'run_npm',
  description:
    'Run an allow-listed npm subcommand inside the project directory (no shell). Use it to add or inspect dependencies that the sandboxed run_bash palette cannot reach.',
  parameters: {
    properties: {
      args: {
        type: 'array',
        items: { type: 'string' },
        description: `npm arguments, subcommand first. Allowed subcommands: ${NPM_ALLOWED_SUBCOMMANDS.join(', ')}. Example: ["install", "neo-blessed"].`
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory (relative path inside the project). Defaults to the project root.'
      },
      timeoutMs: {
        type: 'integer',
        description: `Optional timeout in milliseconds (default ${NPM_DEFAULT_TIMEOUT_MS}).`
      }
    },
    required: ['args']
  },
  async execute(args) {
    let argv;
    try {
      argv = validateNpmArgs(args.args);
    } catch (error) {
      return JSON.stringify({ status: 'error', code: error.code, message: error.message });
    }

    const cwd = args.cwd ? resolveProjectPath(args.cwd) : process.cwd();
    const requested = Number.isInteger(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : NPM_DEFAULT_TIMEOUT_MS;
    const timeout = Math.min(requested, NPM_MAX_TIMEOUT_MS);

    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

    return await new Promise((resolve) => {
      execFile(
        npmBin,
        ['--no-audit', '--no-fund', ...argv],
        { cwd, timeout, maxBuffer: 20 * 1024 * 1024, env: process.env },
        (error, stdout, stderr) => {
          const out = String(stdout ?? '').trimEnd();
          const err = String(stderr ?? '').trimEnd();
          if (error) {
            if (error.killed || error.signal === 'SIGTERM') {
              resolve(JSON.stringify({
                status: 'error',
                code: 'TIMEOUT',
                message: `npm ${argv.join(' ')} timed out after ${timeout}ms.`,
                stdout: out,
                stderr: err
              }));
              return;
            }
            resolve(JSON.stringify({
              status: 'error',
              code: 'NPM_FAILED',
              message: `npm ${argv.join(' ')} failed with exit code ${error.code ?? 'unknown'}.`,
              stdout: out,
              stderr: err
            }));
            return;
          }
          resolve(JSON.stringify({
            status: 'success',
            command: `npm ${argv.join(' ')}`,
            cwd: cwd === process.cwd() ? '.' : cwd,
            stdout: out,
            stderr: err,
            message: `npm ${argv.join(' ')} completed.`
          }));
        }
      );
    });
  }
});

export { definition, execute };
