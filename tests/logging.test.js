import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  LOG_FILE,
  LOG_LEVEL,
  LOG_MAX_BYTES,
  LOG_MAX_BYTES_DEFAULT,
  LOG_MAX_FILES,
  LOG_MAX_FILES_DEFAULT,
} from '../config/constants.js';
import {
  LOG_LEVELS,
  SILENT_LEVEL,
  createLogger,
  formatLogLine,
  logEvent,
  normalizeLogLevel,
  normalizeLogLimit,
  rotateLog,
  serializeLogError,
} from '../utils/logger.js';
import { registerLogger, getLogger, clearLogger } from '../utils/host.js';
import { flattenLogValue, levelEnabled } from '../utils/log-record.js';

/**
 * The operational log (task-backlog: "save logs in some internal local log file that
 * gets auto rotated by this same deterministic code, so we can find errors and stuff.
 * the usual 3 levels: error, warning, info and a level threshold via environment").
 *
 * This file is the logger as a value: the levels and the threshold, the one-line
 * record, the deterministic rotation chain and the promise that a write never throws.
 * Every case runs against a throw-away directory inside the project — the same
 * `agent/` tree the real default lives in — because rotation and the byte budget are
 * filesystem behaviour a stubbed writer would hide. What the *call sites* record is
 * proved separately in tests/logging-sites.test.js.
 */

/** A throw-away log directory inside the project (cleaned up afterwards). */
function tempLogFile(name) {
  const dir = `agent/logs-test-${process.pid}-${name}`;
  fs.rmSync(dir, { recursive: true, force: true });
  return `${dir}/moncho.log`;
}

function cleanup(file) {
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

function readLines(file) {
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
}
test('levelEnabled() decides for any level against any threshold, with no filesystem', () => {
  // The record half (utils/log-record.js) is pure: it decides, it does not write.
  assert.equal(levelEnabled('error', 'warn'), true);
  assert.equal(levelEnabled('warn', 'warn'), true);
  assert.equal(levelEnabled('info', 'warn'), false);
  assert.equal(levelEnabled('error', 'silent'), false, 'silent admits nothing, not even an error');
  assert.equal(levelEnabled('warning', 'warn'), true, 'the alias is resolved here too');
  // A value that cannot be a line is flattened, never allowed to split a record.
  assert.equal(flattenLogValue('a\r\nb'), 'a\\nb');
  assert.equal(flattenLogValue(undefined), '');
});

test('normalizeLogLevel keeps the three levels, the warning alias and a silent switch', () => {
  assert.deepEqual(LOG_LEVELS, ['error', 'warn', 'info']);
  assert.equal(normalizeLogLevel('ERROR'), 'error');
  assert.equal(normalizeLogLevel(' warn '), 'warn');
  assert.equal(normalizeLogLevel('info'), 'info');
  assert.equal(normalizeLogLevel('warning'), 'warn', 'the backlog spells the level in full');
  assert.equal(normalizeLogLevel('off'), SILENT_LEVEL);
  assert.equal(normalizeLogLevel('none'), SILENT_LEVEL);
  // A broken value must not be able to disable or invert the threshold.
  assert.equal(normalizeLogLevel('trace'), 'info');
  assert.equal(normalizeLogLevel(''), 'info');
  assert.equal(normalizeLogLevel(undefined), 'info');
  assert.equal(normalizeLogLevel('nonsense', 'error'), 'error', 'the fallback is normalised too');
});

test('the threshold and the budgets come from the environment with safe defaults', () => {
  // The suite runs with no logging environment set, so the declared defaults hold.
  assert.equal(LOG_LEVEL, 'info');
  assert.equal(LOG_FILE, 'agent/logs/moncho.log');
  assert.equal(LOG_MAX_BYTES, LOG_MAX_BYTES_DEFAULT);
  assert.equal(LOG_MAX_FILES, LOG_MAX_FILES_DEFAULT);
  assert.equal(LOG_MAX_BYTES_DEFAULT, 512 * 1024);

  // The default log directory is the gitignored agent/ tree, next to the sessions.
  const ignore = fs.readFileSync('.gitignore', 'utf-8');
  assert.match(ignore, /^\/agent\/$/m, 'the default log directory must stay gitignored');

  assert.equal(normalizeLogLimit('1024', 1), 1024);
  assert.equal(normalizeLogLimit('0', 7), 7, '0 cannot disable a configured budget by accident');
  assert.equal(normalizeLogLimit('abc', 7), 7);
  assert.equal(normalizeLogLimit(undefined, undefined), 0, 'no fallback means no limit');
});

test('formatLogLine() writes one line with the stamp, the level, the scope and JSON details', () => {
  const line = formatLogLine({
    at: new Date('2026-02-14T10:30:00.000Z'),
    level: 'warn',
    scope: 'provider',
    message: 'attempt 1/3 failed',
    details: { attempt: 1 },
  });

  assert.equal(
    line,
    '2026-02-14T10:30:00.000Z WARN  [provider] attempt 1/3 failed {"attempt":1}\n',
    'a line is one complete, newline-terminated record',
  );
  // A line is a record: a message that contains newlines must not split it.
  const multi = formatLogLine({ at: new Date(0), level: 'info', message: 'a\nb\r\nc' });
  assert.equal(multi.split('\n').length, 2, 'only the terminating newline survives');
  assert.match(multi, /a\\nb\\nc/);
  assert.equal(formatLogLine({ at: new Date(NaN), level: 'info' }).startsWith('1970-01-01'), true);
});

test('serializeLogError() escapes an Error into one plain record', () => {
  const error = Object.assign(new Error('boom\nsecond line'), { code: 'EBOOM' });
  const record = serializeLogError(error);

  assert.equal(record.name, 'Error');
  assert.equal(record.message, 'boom\\nsecond line');
  assert.equal(record.code, 'EBOOM');
  assert.match(record.stack, /Error: boom/);
  assert.equal(serializeLogError('plain').message, 'plain');
  assert.equal(serializeLogError(null).message, '');
});

test('createLogger() keeps a line out of the file below the threshold', () => {
  const file = tempLogFile('levels');
  const logger = createLogger({
    file,
    level: 'warn',
    now: () => new Date('2026-02-14T10:30:00.000Z'),
  });

  assert.equal(logger.level, 'warn');
  assert.equal(logger.enabled('info'), false, 'info is below a warn threshold');
  assert.equal(logger.enabled('warn'), true);
  assert.equal(logger.enabled('error'), true);

  assert.equal(logger.info('startup', 'not kept'), null);
  assert.ok(logger.warn('provider', 'kept'));
  assert.ok(logger.error('session', 'kept too', new Error('nope')));

  const lines = readLines(file);
  assert.equal(lines.length, 2, 'only the lines at or above the threshold are written');
  assert.match(lines[0], /^2026-02-14T10:30:00\.000Z WARN {2}\[provider\] kept$/);
  assert.match(lines[1], /ERROR \[session\] kept too \{"name":"Error","message":"nope"/);

  cleanup(file);
});

test('a silent threshold writes nothing at all', () => {
  const file = tempLogFile('silent');
  const logger = createLogger({ file, level: 'off' });

  assert.equal(logger.level, SILENT_LEVEL);
  assert.equal(logger.enabled('error'), false, 'silent stops even the loudest level');
  assert.equal(logger.error('startup', 'dropped'), null);
  assert.equal(fs.existsSync(file), false, 'a dropped line never touches the disk');

  cleanup(file);
});

test('the file rotates when the next line would pass the byte budget', () => {
  const file = tempLogFile('rotate');
  // A budget wide enough for the first line and too narrow for two of them.
  const logger = createLogger({ file, level: 'info', maxBytes: 120, maxFiles: 3 });

  assert.ok(logger.info('a', 'first'));
  const firstSize = fs.statSync(file).size;
  assert.ok(firstSize < 120);

  assert.ok(logger.info('b', 'second line that will not fit beside the first one'));

  assert.ok(fs.existsSync(`${file}.1`), 'the full file was archived');
  assert.match(fs.readFileSync(`${file}.1`, 'utf-8'), /first/);
  const current = fs.readFileSync(file, 'utf-8');
  assert.match(current, /rotated .*moncho\.log; keeping 3 file\(s\) of 120 bytes/, 'the rotation is announced in the log itself');
  assert.match(current, /second line/, 'the new line lands in the fresh file');

  cleanup(file);
});

test('rotation keeps at most maxFiles files, newest first, without losing the live one', () => {
  const file = tempLogFile('chain');
  const logger = createLogger({ file, level: 'info', maxBytes: 90, maxFiles: 3 });

  for (let index = 1; index <= 6; index += 1) {
    logger.info('probe', `line number ${index} padded to force a rotation`);
  }

  assert.ok(fs.existsSync(file), 'the live file is never the one dropped');
  assert.ok(fs.existsSync(`${file}.1`));
  assert.ok(fs.existsSync(`${file}.2`));
  assert.equal(fs.existsSync(`${file}.3`), false, 'maxFiles counts the live file');
  assert.match(fs.readFileSync(file, 'utf-8'), /line number 6/);
  assert.match(fs.readFileSync(`${file}.1`, 'utf-8'), /line number 5/, 'the archive holds what just left the live file');

  // Rotation is deterministic: the same chain, the same names, no clock anywhere.
  const again = rotateLog(file, { maxFiles: 3 });
  assert.equal(again.rotated, true);
  assert.deepEqual(again.archives.map((p) => path.basename(p)), ['moncho.log.1', 'moncho.log.2']);

  cleanup(file);
});

test('a single kept file restarts the log instead of archiving it', () => {
  const file = tempLogFile('keep1');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'old content\n', 'utf-8');

  const result = rotateLog(file, { maxFiles: 1 });

  assert.equal(result.rotated, true);
  assert.equal(result.archives.length, 0);
  assert.equal(fs.existsSync(file), false, 'the log is restarted, not renamed');

  cleanup(file);
});

test('a log path that cannot be written never throws and reports why', () => {
  const file = tempLogFile('broken');
  const logger = createLogger({
    file,
    level: 'info',
    // The sandbox refuses a path that escapes the project, exactly like every file tool.
    resolvePath: () => { throw new Error('cannot resolve the path'); },
  });

  assert.equal(logger.error('startup', 'this must not throw'), null);
  assert.equal(logger.getFailure()?.message, 'cannot resolve the path');
  assert.equal(fs.existsSync(file), false);

  // The same is true of a writer that fails: the failure is recorded, the turn lives.
  const throwing = createLogger({ file, append: () => { throw new Error('disk full'); } });
  assert.equal(throwing.warn('tool', 'still fine'), null);
  assert.equal(throwing.getFailure()?.message, 'disk full');

  cleanup(file);
});

test('logEvent() writes through the registered logger and is silent without one', () => {
  const file = tempLogFile('registry');
  clearLogger();
  assert.equal(getLogger(), null);
  assert.equal(logEvent('error', 'startup', 'dropped, no logger'), null);
  assert.equal(fs.existsSync(file), false, 'no logger means no file, and no side effect');

  const logger = createLogger({ file, level: 'info', now: () => new Date(0) });
  registerLogger(logger);
  assert.equal(getLogger(), logger);

  assert.ok(logEvent('info', 'startup', 'through the registry'));
  assert.match(fs.readFileSync(file, 'utf-8'), /\[startup\] through the registry/);

  // A broken logger must never cost the caller the turn: logEvent() swallows it.
  registerLogger({ log: () => { throw new Error('broken sink'); } });
  assert.equal(logEvent('error', 'startup', 'swallowed'), null);

  clearLogger();
  assert.equal(getLogger(), null);
  cleanup(file);
});
