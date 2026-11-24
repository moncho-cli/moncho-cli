import fs from 'fs';
import path from 'path';

import {
  LOG_FILE,
  LOG_LEVEL,
  LOG_MAX_BYTES,
  LOG_MAX_FILES,
} from '../config/constants.js';
import { resolveProjectPath } from './path-safety.js';
import { getLogger } from './host.js';
import {
  LOG_LEVELS,
  LOG_LEVEL_ORDER,
  SILENT_LEVEL,
  formatLogLine,
  levelEnabled,
  normalizeLogLevel,
  normalizeLogLimit,
  serializeLogError,
} from './log-record.js';

/**
 * The operational log (task-backlog: "save logs in some internal local log file
 * that gets auto rotated by this same deterministic code, so we can find errors and
 * stuff. the usual 3 leves: error, warning, info and a level threshold via
 * environment").
 *
 * This module is the **sink**: where a line goes, when the file rotates, and why a
 * write can never throw. What a level *is* and what one line *looks like* lives in
 * `utils/log-record.js`, which is pure and therefore provable without a directory.
 *
 * Two decisions shape the sink:
 *
 *  - **The file stays inside the workspace.** The path goes through
 *    `resolveProjectPath()`, the same sandbox every file tool uses, and defaults to
 *    the gitignored `agent/logs/` tree — an operational log belongs with the
 *    workspace it describes, not in `/tmp`.
 *  - **Writing a log line can never cost the turn it describes.** Every failure is
 *    captured in the logger's `getFailure()` instead of being thrown, so a read-only
 *    or missing directory degrades the log, not the session.
 *
 * Rotation is deterministic and synchronous: when the next line would push the file
 * past `maxBytes`, the file is renamed to `<file>.1` and the chain is shifted, with
 * at most `maxFiles` files kept (the live one included). No timer, no external
 * logrotate, no clock beyond the timestamp of the lines themselves.
 */

// The level set, the threshold rule and the line shape are re-exported here because
// this is the module the call sites and the docs name; the implementation is the
// pure half.
export {
  LOG_LEVELS,
  LOG_LEVEL_ORDER,
  SILENT_LEVEL,
  formatLogLine,
  normalizeLogLevel,
  normalizeLogLimit,
  serializeLogError,
};

/**
 * Shift the rotation chain of one log file, keeping at most `maxFiles` files in
 * total (the live file included), newest first: `<file>`, `<file>.1`, `<file>.2`…
 * The oldest archive is dropped, never the newest one. Deterministic: the same call
 * on the same directory always produces the same set of files.
 *
 * @returns {{rotated: boolean, file: string, archives: string[]}}
 */
export function rotateLog(file, { maxFiles = LOG_MAX_FILES, resolvePath = resolveProjectPath } = {}) {
  const absolute = resolvePath(file);
  const keep = normalizeLogLimit(maxFiles, LOG_MAX_FILES);
  if (!fs.existsSync(absolute)) return { rotated: false, file, archives: [] };

  // A single file kept means the log is simply restarted, not archived.
  if (keep <= 1) {
    fs.unlinkSync(absolute);
    return { rotated: true, file, archives: [] };
  }

  const oldest = `${absolute}.${keep - 1}`;
  if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
  for (let index = keep - 2; index >= 1; index -= 1) {
    const from = `${absolute}.${index}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${absolute}.${index + 1}`);
  }
  fs.renameSync(absolute, `${absolute}.1`);

  const archives = [];
  for (let index = 1; index <= keep - 1; index += 1) {
    const candidate = `${absolute}.${index}`;
    if (fs.existsSync(candidate)) archives.push(candidate);
  }
  return { rotated: true, file, archives };
}

/**
 * Build a logger.
 *
 * @param {object} [options]
 * @param {string} [options.file] project-relative path of the live log file
 * @param {string} [options.level] the threshold (`error`/`warn`/`info`, or `silent`)
 * @param {number} [options.maxBytes] rotate when the next line would pass this
 * @param {number} [options.maxFiles] files kept in the chain, live one included
 * @param {Function} [options.now] the clock, injected so lines are deterministic
 * @param {Function} [options.resolvePath] the path sandbox (injected for tests)
 * @param {Function} [options.append] the writer (injected for tests)
 */
export function createLogger({
  file = LOG_FILE,
  level = LOG_LEVEL,
  maxBytes = LOG_MAX_BYTES,
  maxFiles = LOG_MAX_FILES,
  now = () => new Date(),
  resolvePath = resolveProjectPath,
  append = null,
} = {}) {
  const threshold = normalizeLogLevel(level);
  const budget = normalizeLogLimit(maxBytes, LOG_MAX_BYTES);
  const keep = normalizeLogLimit(maxFiles, LOG_MAX_FILES);
  let failure = null;

  const appendText = (absolute, text) => {
    if (typeof append === 'function') {
      append(absolute, text);
      return;
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.appendFileSync(absolute, text, 'utf-8');
  };

  const write = (text) => {
    try {
      const absolute = resolvePath(file);
      const existing = fs.existsSync(absolute) ? fs.statSync(absolute).size : 0;
      const bytes = Buffer.byteLength(text, 'utf-8');
      // An empty file is never rotated: a single oversized line would otherwise
      // rotate on every write and keep nothing at all.
      if (budget > 0 && existing > 0 && existing + bytes > budget) {
        const rotation = rotateLog(file, { maxFiles: keep, resolvePath });
        if (rotation.rotated) {
          appendText(absolute, formatLogLine({
            at: now(),
            level: 'info',
            scope: 'logger',
            message: `rotated ${file}; keeping ${keep} file(s) of ${budget} bytes`,
          }));
        }
      }
      appendText(absolute, text);
      return true;
    } catch (error) {
      failure = error;
      return false;
    }
  };

  const log = (eventLevel, scope, message, details = null) => {
    if (!levelEnabled(eventLevel, threshold)) return null;
    const line = formatLogLine({ at: now(), level: eventLevel, scope, message, details });
    return write(line) ? line : null;
  };

  return {
    file,
    level: threshold,
    maxBytes: budget,
    maxFiles: keep,
    enabled: (candidate) => levelEnabled(candidate, threshold),
    log,
    error: (scope, message, details) => log('error', scope, message, details),
    warn: (scope, message, details) => log('warn', scope, message, details),
    info: (scope, message, details) => log('info', scope, message, details),
    /** Rotate on demand (the same code the size budget uses). */
    rotate: () => rotateLog(file, { maxFiles: keep, resolvePath }),
    /** Why the last write did not land, or null: the log never throws. */
    getFailure: () => failure,
  };
}

/**
 * Write one event to the *registered* logger (`utils/host.js#registerLogger`), which
 * `main.js` installs at startup.
 *
 * Going through the registry is what keeps the deep modules honest: `api/ollama.js`
 * and `app/turn-runner.js` may call `logEvent()` from any context — including a unit
 * test or a bare tool call — and with no logger registered the event is dropped
 * instead of a file being created behind the caller's back.
 *
 * @returns {string|null} the line written, or null when nothing was logged
 */
export function logEvent(level, scope, message, details = null) {
  const logger = getLogger();
  if (!logger || typeof logger.log !== 'function') return null;
  try {
    return logger.log(level, scope, message, details);
  } catch {
    // A log line must never cost the turn it describes.
    return null;
  }
}
