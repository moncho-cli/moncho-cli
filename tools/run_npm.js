import { execFile } from 'child_process';
import {
  NPM_ALLOWED_SUBCOMMANDS,
  NPM_DEFAULT_TIMEOUT_MS,
  NPM_MAX_TIMEOUT_MS
} from '../config/constants.js';
import { resolveProjectPath } from '../utils/path-safety.js';
import { defineTool } from '../utils/tool-schema.js';
import {
  windowCaptured,
  renderCommandOutput,
  CAPTURE_HINT
} from '../utils/command-output.js';
import { putCapture } from '../utils/capture-store.js';

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
          const command = `npm ${argv.join(' ')}`;
          if (error) {
            resolve(JSON.stringify(npmFailure({
              command,
              cwd,
              out,
              err,
              code: error.killed || error.signal === 'SIGTERM' ? 'TIMEOUT' : 'NPM_FAILED',
              exitCode: error.code ?? 'unknown',
              timeout
            })));
            return;
          }
          // A success is the same document run_bash answers with: a bounded window, and
          // the whole stream behind a capture handle when it did not fit.
          const selected = windowCaptured(out, {});
          const capture = selected.truncated ? putCapture({ command, text: out }) : null;
          const tail = windowCaptured(err, {});
          resolve(renderCommandOutput({
            command,
            cwd: cwd === process.cwd() ? '.' : cwd,
            exitCode: 0,
            stdout: selected.text,
            total: selected.total,
            shown: selected.shown,
            truncated: selected.truncated,
            mode: selected.mode,
            ...(capture ? { capture: capture.id, hint: CAPTURE_HINT } : {}),
            ...(tail.shown > 0 ? { stderr_lines: tail.total, stderr_shown: tail.shown } : {})
          }));
        }
      );
    });
  }
});

/**
 * A failing npm run: the structured envelope the harness relies on, with both streams
 * windowed and — when the output was cut — the capture that holds the rest, because a
 * failing run is exactly the one whose full output the model needs to scan.
 */
export function npmFailure({ command, cwd, out, err, code, exitCode, timeout = null }) {
  const stdout = windowCaptured(out, {});
  const stderr = windowCaptured(err, {});
  const capture = stdout.truncated ? putCapture({ command, text: out }) : null;
  return {
    status: 'error',
    code,
    message: code === 'TIMEOUT'
      ? `${command} timed out after ${timeout}ms.`
      : `${command} failed with exit code ${exitCode}.`,
    cwd: cwd === process.cwd() ? '.' : cwd,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutLines: stdout.total,
    stdoutShown: stdout.shown,
    stdoutTruncated: stdout.truncated,
    stderrLines: stderr.total,
    stderrShown: stderr.shown,
    stderrTruncated: stderr.truncated,
    mode: stdout.mode,
    ...(capture ? { capture: capture.id, hint: CAPTURE_HINT } : {})
  };
}

export { definition, execute };
