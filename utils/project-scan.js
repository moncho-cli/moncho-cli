import fs from 'fs';
import path from 'path';
import { resolveProjectPath } from './path-safety.js';

/**
 * Shared discovery primitives for the read-only exploration tools (`grep`, `blob`).
 *
 * Everything here stays inside the path sandbox: paths are resolved through
 * resolveProjectPath(), symlinks are never followed, and the walker refuses to
 * descend into dependency/VCS directories so a whole-project search cannot blow up
 * the context window with node_modules noise.
 */

/** Directories never walked unless the caller points at them directly. */
export const DEFAULT_IGNORED_DIRS = [
  'node_modules',
  '.git',
  'vendor',
  'agent',
  'dist',
  'build',
  'coverage'
];

/** File names never returned by discovery tools. */
export const DEFAULT_IGNORED_FILES = ['*.log', '*.tmp', '*.moncho-write-*.tmp', '.DS_Store'];

const BINARY_SNIFF_BYTES = 8192;

/** True when the caller asked for the project root rather than a real path. */
export function isProjectRootRequest(input) {
  return input === undefined || input === null || input === ''
    || input === '.' || input === './';
}

/**
 * Normalise a glob argument into a clean list. Accepts a string (comma-separated
 * globs allowed), an array of strings, or nothing.
 * @param {string|string[]|null|undefined} value
 * @returns {string[]}
 */
export function normalizeGlobs(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((entry) => typeof entry === 'string')
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** Compile a glob (`*`, `**`, `?`) to an anchored RegExp. A slash-free glob matches the basename. */
function globToRegExp(glob) {
  const normalized = glob.split(path.sep).join('/').replace(/^\.\//, '');
  let source = '^';
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`${source}$`);
}

/**
 * Match a project-relative POSIX path against a glob.
 * @param {string} relativePath
 * @param {string} glob
 * @returns {boolean}
 */
export function matchGlob(relativePath, glob) {
  if (typeof relativePath !== 'string' || typeof glob !== 'string') return false;
  const target = relativePath.split(path.sep).join('/');
  const pattern = glob.trim().replace(/^\.\//, '');
  if (pattern === '') return false;
  const candidate = pattern.includes('/') ? target : target.split('/').pop();
  return globToRegExp(pattern).test(candidate);
}

/** True when the path matches any of the globs (an empty list matches nothing). */
export function matchesAny(relativePath, globs) {
  return normalizeGlobs(globs).some((glob) => matchGlob(relativePath, glob));
}

/**
 * Heuristic binary sniff on a buffer: a NUL byte in the first 8 KiB means "not text".
 * Pure so both tools (and the tests) can use it without touching the filesystem.
 * @param {Buffer} buffer
 * @param {number} [sniffBytes]
 * @returns {boolean}
 */
export function looksBinary(buffer, sniffBytes = BINARY_SNIFF_BYTES) {
  if (!Buffer.isBuffer(buffer)) return false;
  const limit = Math.min(buffer.length, sniffBytes);
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Normalise AND-ed glob groups: each group is "match at least one of these", and
 * every group must match. Used when a caller has two filters that must both hold
 * (e.g. `blob` path `app/*.js` plus `include: "*.md"`).
 * @param {Array<string|string[]>} groups
 * @returns {string[][]}
 */
export function normalizeGlobGroups(groups) {
  const list = Array.isArray(groups) ? groups : [groups];
  return list.map((group) => normalizeGlobs(group)).filter((group) => group.length > 0);
}

/**
 * List project-relative files under a path, applying the ignore lists and globs.
 *
 * The starting path itself is never ignored (so `path: "node_modules"` works), but
 * ignored directories are pruned during the walk. Symlinks are skipped entirely.
 *
 * @param {object} [options]
 * @param {string} [options.startPath] file or directory, `.` for the project root
 * @param {string|string[]} [options.include] globs a file must match (OR within)
 * @param {Array<string|string[]>} [options.includeAll] glob groups that must all match (AND across)
 * @param {string|string[]} [options.exclude] globs that skip a file
 * @param {number} [options.maxFiles] hard cap on returned files
 * @param {string[]} [options.ignoredDirs]
 * @param {string[]} [options.ignoredFiles]
 * @returns {{files: string[], truncated: boolean}}
 */
export function listProjectFiles({
  startPath = '.',
  include = [],
  includeAll = [],
  exclude = [],
  maxFiles = 2000,
  ignoredDirs = DEFAULT_IGNORED_DIRS,
  ignoredFiles = DEFAULT_IGNORED_FILES
} = {}) {
  const root = process.cwd();
  const absStart = isProjectRootRequest(startPath) ? root : resolveProjectPath(startPath);
  const toRelative = (abs) => path.relative(root, abs).split(path.sep).join('/');

  const includes = normalizeGlobs(include);
  const groups = normalizeGlobGroups(includeAll);

  const accept = (relative) => {
    const base = relative.split('/').pop();
    if (matchesAny(relative, ignoredFiles) || matchesAny(base, ignoredFiles)) return false;
    if (matchesAny(relative, exclude) || matchesAny(base, exclude)) return false;
    if (includes.length > 0 && !matchesAny(relative, includes) && !matchesAny(base, includes)) return false;
    for (const group of groups) {
      if (!matchesAny(relative, group) && !matchesAny(base, group)) return false;
    }
    return true;
  };

  if (fs.statSync(absStart).isFile()) {
    return { files: [toRelative(absStart)], truncated: false };
  }

  const files = [];
  let truncated = false;

  const walk = (dirAbs) => {
    if (truncated) return;
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (truncated) return;
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirs.includes(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = toRelative(abs);
      if (!accept(relative)) continue;
      files.push(relative);
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
    }
  };

  walk(absStart);
  return { files: files.sort(), truncated };
}

/**
 * The project-relative display form of a requested path (`"."` for the root).
 * @param {string} [input]
 * @returns {string}
 */
export function displayPath(input) {
  if (isProjectRootRequest(input)) return '.';
  return path.relative(process.cwd(), resolveProjectPath(input)).split(path.sep).join('/');
}

/**
 * Read a text file safely, returning null for missing/binary/oversized files.
 * @param {string} relativePath
 * @param {number} [maxBytes]
 * @returns {{content: string, bytes: number}|null}
 */
export function readTextFile(relativePath, maxBytes = 2 * 1024 * 1024) {
  let buffer;
  try {
    buffer = fs.readFileSync(resolveProjectPath(relativePath));
  } catch {
    return null;
  }
  if (buffer.length > maxBytes || looksBinary(buffer)) return null;
  return { content: buffer.toString('utf-8'), bytes: buffer.length };
}
