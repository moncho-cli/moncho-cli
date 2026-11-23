import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execute as grepExecute, buildSearchRegExp, searchFile } from '../tools/grep.js';
import { execute as blobExecute, clampCap, isGlobPattern, resolveBlobTargets } from '../tools/blob.js';
import {
  DEFAULT_IGNORED_DIRS,
  displayPath,
  isProjectRootRequest,
  listProjectFiles,
  looksBinary,
  matchGlob,
  matchesAny,
  normalizeGlobs,
  normalizeGlobGroups,
  readTextFile
} from '../utils/project-scan.js';

/**
 * Proof for the read-only discovery tools (docs/agent/project-discovery).
 *
 * `grep` finds where a string lives; `blob` returns several files in one call.
 * Both walk the project through utils/project-scan.js, so the sandbox, the ignore
 * lists and the glob matcher are proven here too.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moncho-discovery-test-'));
process.chdir(root);

function writeFile(name, content) {
  fs.mkdirSync(path.dirname(name), { recursive: true });
  fs.writeFileSync(name, content, 'utf-8');
}

writeFile('app/alpha.js', 'export const alpha = 1;\n// needle here\n');
writeFile('app/beta.js', 'export const beta = 2;\n');
writeFile('utils/gamma.js', '// NEEDLE upper\n');
writeFile('notes.md', 'needle in markdown\n');
writeFile('node_modules/pkg/index.js', '// needle in dependencies\n');
writeFile('agent/scratch.js', '// needle in scratch space\n');
writeFile('assets/bin.dat', Buffer.from([0, 1, 2, 3]));
writeFile('logs/trace.log', 'needle in a log\n');

// ---------------------------------------------------------------------------
// globs and the project walker
// ---------------------------------------------------------------------------

test('glob matching handles basenames, paths and recursive patterns', () => {
  assert.equal(matchGlob('app/alpha.js', '*.js'), true);
  assert.equal(matchGlob('app/alpha.js', 'app/*.js'), true);
  assert.equal(matchGlob('app/alpha.js', 'utils/*.js'), false);
  assert.equal(matchGlob('app/nested/deep.js', 'app/**/*.js'), true);
  assert.equal(matchGlob('app/alpha.js', 'app/**/*.js'), true);
  assert.equal(matchGlob('app/alpha.js', 'app/alpha.??'), true);
  assert.equal(matchGlob('app/alpha.js', ''), false);
  assert.equal(matchGlob('app/alpha.js', './app/*.js'), true);
});

test('normalizeGlobs accepts strings, comma-separated lists and arrays', () => {
  assert.deepEqual(normalizeGlobs(undefined), []);
  assert.deepEqual(normalizeGlobs('  '), []);
  assert.deepEqual(normalizeGlobs('*.js'), ['*.js']);
  assert.deepEqual(normalizeGlobs('*.js, *.md'), ['*.js', '*.md']);
  assert.deepEqual(normalizeGlobs(['*.js', '', '*.md']), ['*.js', '*.md']);
  assert.equal(matchesAny('app/alpha.js', '*.js,*.md'), true);
  assert.equal(matchesAny('app/alpha.js', []), false);
  assert.deepEqual(normalizeGlobGroups(['*.js', '']), [['*.js']]);
});

test('listProjectFiles prunes ignored directories and honours globs', () => {
  const all = listProjectFiles({});
  assert.ok(all.files.includes('app/alpha.js'));
  assert.ok(!all.files.some((file) => file.startsWith('node_modules/')), 'node_modules must be pruned');
  assert.ok(!all.files.some((file) => file.startsWith('agent/')), 'agent scratch space must be pruned');
  assert.ok(!all.files.some((file) => file.endsWith('.log')), 'log files are ignored by default');

  const jsOnly = listProjectFiles({ include: '*.js' });
  assert.deepEqual(jsOnly.files, ['app/alpha.js', 'app/beta.js', 'utils/gamma.js']);

  const excluded = listProjectFiles({ include: '*.js', exclude: 'app/*.js' });
  assert.deepEqual(excluded.files, ['utils/gamma.js']);

  const capped = listProjectFiles({ include: '*.js', maxFiles: 2 });
  assert.equal(capped.files.length, 2);
  assert.equal(capped.truncated, true);

  // A single file resolves to itself, and ignored dirs are reachable when named.
  assert.deepEqual(listProjectFiles({ startPath: 'app/alpha.js' }).files, ['app/alpha.js']);
  assert.deepEqual(
    listProjectFiles({ startPath: 'node_modules', ignoredDirs: [] }).files,
    ['node_modules/pkg/index.js']
  );
  assert.deepEqual(listProjectFiles({ includeAll: ['app/*.js', '*.js'] }).files, ['app/alpha.js', 'app/beta.js']);
  assert.deepEqual(listProjectFiles({ includeAll: ['app/*.js', '*.md'] }).files, []);
  assert.ok(DEFAULT_IGNORED_DIRS.includes('node_modules'));
});

test('path helpers report the project root and refuse to escape it', () => {
  assert.equal(isProjectRootRequest('.'), true);
  assert.equal(isProjectRootRequest(undefined), true);
  assert.equal(isProjectRootRequest('app'), false);
  assert.equal(displayPath('.'), '.');
  assert.equal(displayPath('app/alpha.js'), 'app/alpha.js');
  assert.throws(() => displayPath('../outside'), (error) => error.code === 'INVALID_PATH');
});

test('looksBinary detects NUL bytes and readTextFile skips binary files', () => {
  assert.equal(looksBinary(Buffer.from('plain text')), false);
  assert.equal(looksBinary(Buffer.from([0, 1, 2])), true);
  assert.equal(looksBinary('not a buffer'), false);

  assert.equal(readTextFile('app/alpha.js').content.includes('needle'), true);
  assert.equal(readTextFile('assets/bin.dat'), null);
  assert.equal(readTextFile('does-not-exist.txt'), null);
});

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

test('buildSearchRegExp honours literal and case-insensitive modes', () => {
  assert.equal(buildSearchRegExp('a.c').test('abc'), true);
  assert.equal(buildSearchRegExp('a.c', { fixedStrings: true }).test('abc'), false);
  assert.equal(buildSearchRegExp('a.c', { fixedStrings: true }).test('a.c'), true);
  assert.equal(buildSearchRegExp('needle', { ignoreCase: true }).test('NEEDLE'), true);
  assert.throws(() => buildSearchRegExp('([a-'), (error) => error.code === 'INVALID_PATTERN');
});

test('searchFile returns line numbers and skips binary files', () => {
  const hits = searchFile('app/alpha.js', { source: 'needle', flags: 'g', remaining: 10 });
  assert.deepEqual(hits, [{ line: 2, text: '// needle here' }]);
  assert.equal(searchFile('assets/bin.dat', { source: 'needle', flags: 'g', remaining: 10 }), null);
  assert.equal(searchFile('missing.txt', { source: 'needle', flags: 'g', remaining: 10 }), null);
});

test('grep reports path:line matches wrapped in <grep> tags', async () => {
  const result = await grepExecute({ pattern: 'needle', intent: 'find the needle' });
  assert.match(result, /^<grep pattern="needle" path="\." matches=2 files=2>\n/);
  assert.ok(result.includes('app/alpha.js:2: // needle here'));
  assert.ok(result.includes('notes.md:1: needle in markdown'));
  assert.ok(!result.includes('node_modules'), 'dependencies must not be searched');
  assert.ok(result.endsWith('\n</grep>'));
});

test('grep supports include, filesOnly, ignoreCase and fixedStrings', async () => {
  const jsOnly = await grepExecute({ pattern: 'needle', include: '*.js', intent: 'narrow to js' });
  assert.ok(jsOnly.includes('app/alpha.js:2:'));
  assert.ok(!jsOnly.includes('notes.md'));

  const filesOnly = await grepExecute({ pattern: 'needle', include: '*.js', filesOnly: true, intent: 'paths only' });
  assert.match(filesOnly, /files=1/);
  assert.ok(filesOnly.includes('\napp/alpha.js\n'));

  const insensitive = await grepExecute({ pattern: 'needle', ignoreCase: true, intent: 'case-insensitive' });
  assert.ok(insensitive.includes('utils/gamma.js:1: // NEEDLE upper'));

  const literal = await grepExecute({ pattern: 'beta = 2', fixedStrings: true, intent: 'literal match' });
  assert.ok(literal.includes('app/beta.js:1: export const beta = 2;'));
});

test('grep caps results and reports truncation', async () => {
  const result = await grepExecute({ pattern: 'needle', maxResults: 1, intent: 'cap the output' });
  assert.match(result, /matches=1 files=1 truncated=true>/);
});

test('grep reports no-match and error results without throwing', async () => {
  const empty = await grepExecute({ pattern: 'zzz-not-present', intent: 'expect nothing' });
  assert.match(empty, /matches=0 files=0>/);
  assert.ok(empty.includes('(no matches)'));

  const badPattern = JSON.parse(await grepExecute({ pattern: '([a-', intent: 'invalid regex' }));
  assert.equal(badPattern.status, 'error');
  assert.equal(badPattern.code, 'INVALID_PATTERN');
  assert.ok(badPattern.guidance.includes('fixedStrings'));

  const missingPattern = JSON.parse(await grepExecute({ intent: 'no pattern' }));
  assert.equal(missingPattern.code, 'INVALID_PATTERN');

  const escape = JSON.parse(await grepExecute({ pattern: 'needle', path: '../', intent: 'escape attempt' }));
  assert.equal(escape.code, 'INVALID_PATH');
  assert.ok(escape.guidance.includes('relative path'));
});

// ---------------------------------------------------------------------------
// blob
// ---------------------------------------------------------------------------

test('resolveBlobTargets treats globs and directories as file lists', () => {
  assert.equal(isGlobPattern('app/*.js'), true);
  assert.equal(isGlobPattern('app/alpha.js'), false);

  assert.deepEqual(resolveBlobTargets('app/*.js').files, ['app/alpha.js', 'app/beta.js']);
  assert.deepEqual(resolveBlobTargets('utils').files, ['utils/gamma.js']);
  assert.deepEqual(resolveBlobTargets('app/alpha.js').files, ['app/alpha.js']);
  assert.deepEqual(resolveBlobTargets('app/*.js', { include: '*.md' }).files, []);
});

test('blob returns each file wrapped in <blob> tags', async () => {
  const result = await blobExecute({ path: 'app/*.js', intent: 'read both app files' });
  assert.match(result, /^<blobs path="app\/\*\.js" count=2 bytes=\d+>\n/);
  assert.ok(result.includes('<blob path="app/alpha.js" bytes=39 lines=3>'));
  assert.ok(result.includes('export const alpha = 1;'));
  assert.ok(result.includes('<blob path="app/beta.js"'));
  assert.ok(result.endsWith('\n</blobs>'));
});

test('blob marks binary files instead of failing', async () => {
  const result = await blobExecute({ path: 'assets', intent: 'try a binary file' });
  assert.match(result, /count=1/);
  assert.ok(result.includes('<blob path="assets/bin.dat" skipped="binary-or-too-large" />'));
});

test('blob caps the number of files and the bytes returned', async () => {
  const capped = await blobExecute({ path: 'app/*.js', maxFiles: 1, intent: 'cap the file count' });
  assert.match(capped, /^<blobs path="app\/\*\.js" count=1 bytes=\d+ truncated=true>/);
  assert.ok(capped.includes('app/alpha.js'));
  assert.ok(!capped.includes('app/beta.js'));

  const byteCapped = await blobExecute({ path: 'app/*.js', maxTotalBytes: 20, intent: 'cap the bytes' });
  assert.match(byteCapped, /^<blobs path="app\/\*\.js" count=1 bytes=20 truncated=true>/);
  assert.ok(byteCapped.includes('<blob path="app/alpha.js" bytes=20 lines=1 truncated=true>'));
});

test('blob clamps a loose request to the hard ceilings', async () => {
  // A bare call is bounded by the defaults; the ceilings bound the *request*, so a
  // model that asks for a gigantic read is answered the ceiling, not a gigantic
  // response. Clamping keeps the call useful: the tag still reports truncated=true.
  assert.equal(clampCap(undefined, 8, 40), 8, 'absent falls back to the default');
  assert.equal(clampCap(12, 8, 40), 12, 'a request under the ceiling is honoured');
  assert.equal(clampCap(10000, 8, 40), 40, 'a request past the ceiling is clamped');
  assert.equal(clampCap(-3, 8, 40), 8, 'a nonsense value falls back rather than clamping to it');

  const loose = await blobExecute({ path: 'app/*.js', maxFiles: 10000, maxTotalBytes: 999999999, intent: 'ask for everything' });
  const header = loose.slice(0, loose.indexOf('\n'));
  assert.match(header, /^<blobs path="app\/\*\.js" count=2 bytes=\d+>/, 'the ceiling is far above this fixture, so nothing is truncated');
});

test('blob reports a structured error when nothing matches', async () => {
  const result = JSON.parse(await blobExecute({ path: 'nope/*.js', intent: 'expect a miss' }));  assert.equal(result.status, 'error');
  assert.equal(result.code, 'NOT_FOUND');
  assert.ok(result.guidance.includes('glob'));

  const escape = JSON.parse(await blobExecute({ path: '../outside', intent: 'escape attempt' }));
  assert.equal(escape.code, 'INVALID_PATH');
});

test('blob defaults to the project root', async () => {
  const result = await blobExecute({ intent: 'dump the project' });
  assert.match(result, /^<blobs path="\." count=\d+/);
  assert.ok(result.includes('app/alpha.js'));
});
