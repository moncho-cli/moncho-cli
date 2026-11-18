import fs from 'fs';
import { resolveProjectPath } from '../utils/path-safety.js';
import { defineTool } from '../utils/tool-schema.js';
import { displayPath, listProjectFiles, looksBinary } from '../utils/project-scan.js';

/**
 * Search file contents across the project and return `path:line: text` matches.
 *
 * This is the *discovery* companion to read_file: it answers "where does this
 * string live?" without the model having to guess paths or page through files.
 * `before`/`after` widen each match into a window of surrounding lines, so a hit
 * can be read in place instead of costing a follow-up read_file call.
 *
 * It never writes, never follows symlinks and never walks node_modules/.git.
 */

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RESULTS = 200;
const MAX_LINE_PREVIEW = 400;
/** Hard ceiling per side: context must not multiply the output of a broad search. */
export const MAX_CONTEXT_LINES = 20;

/** Escape a literal string so it can be embedded in a RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the search RegExp. Pure, so the tests can exercise it directly.
 * @param {string} pattern
 * @param {{ignoreCase?: boolean, fixedStrings?: boolean}} [options]
 * @returns {RegExp}
 */
export function buildSearchRegExp(pattern, { ignoreCase = false, fixedStrings = false } = {}) {
  const source = fixedStrings ? escapeRegExp(pattern) : pattern;
  const flags = ignoreCase ? 'gi' : 'g';
  try {
    return new RegExp(source, flags);
  } catch (error) {
    const wrapped = new Error(`Invalid search pattern: ${error.message}`);
    wrapped.code = 'INVALID_PATTERN';
    throw wrapped;
  }
}

/** Clamp a requested context width into [0, MAX_CONTEXT_LINES]. */
export function normalizeContextLines(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Math.floor(number), MAX_CONTEXT_LINES);
}

/** Shorten one display line so a minified file cannot flood the result. */
function preview(text) {
  const line = String(text ?? '').replace(/\r$/, '');
  return line.length > MAX_LINE_PREVIEW ? `${line.slice(0, MAX_LINE_PREVIEW)}…` : line;
}

/**
 * Read a file as display lines. Returns null when the file is unreadable, too
 * large or binary, so the caller can skip it without try/catch noise.
 */
export function readSearchableLines(relativePath) {
  let buffer;
  try {
    buffer = fs.readFileSync(resolveProjectPath(relativePath));
  } catch {
    return null;
  }
  if (buffer.length > MAX_FILE_BYTES || looksBinary(buffer)) return null;
  return buffer.toString('utf-8').split('\n');
}

/**
 * Collect the matching lines of an already-read file.
 * Pure with respect to the filesystem, which keeps the window logic testable.
 */
export function findMatches(lines, { source, flags, remaining = DEFAULT_MAX_RESULTS }) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = preview(lines[i]);
    if (!new RegExp(source, flags).test(line)) continue;
    hits.push({ line: i + 1, text: line });
    if (hits.length >= remaining) break;
  }
  return hits;
}

/**
 * Collect matching lines for one file.
 * Returns null when the file is unreadable, too large or binary.
 */
export function searchFile(relativePath, { source, flags, remaining }) {
  const lines = readSearchableLines(relativePath);
  if (!lines) return null;
  return findMatches(lines, { source, flags, remaining });
}

/**
 * Turn hits into display windows: every match plus `before`/`after` surrounding
 * lines. Windows that overlap or touch are merged, so a line is never printed
 * twice and adjacent hits share their context.
 *
 * Returns `[{ start, end, lines: [{ line, text, match }] }]` with 1-based line
 * numbers; with before = after = 0 it yields one single-line window per hit.
 */
export function buildContextWindows(lines, hits, { before = 0, after = 0 } = {}) {
  const groups = [];
  for (const hit of hits) {
    const start = Math.max(1, hit.line - before);
    const end = Math.min(lines.length, hit.line + after);
    const last = groups.at(-1);
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
      last.matches.add(hit.line);
      continue;
    }
    groups.push({ start, end, matches: new Set([hit.line]) });
  }

  return groups.map((group) => ({
    start: group.start,
    end: group.end,
    lines: lines.slice(group.start - 1, group.end).map((text, index) => {
      const line = group.start + index;
      return { line, text: preview(text), match: group.matches.has(line) };
    })
  }));
}

/** One display line: `path:line: text` for a match, `path-line- text` for context. */
export function formatWindowLine(path, entry) {
  const separator = entry.match ? ':' : '-';
  return `${path}${separator}${entry.line}${separator} ${entry.text}`;
}

/** Render the reached windows of every file, `--` between non-contiguous groups. */
export function renderWindows(windows) {
  const out = [];
  windows.forEach((window, index) => {
    if (index > 0) out.push('--');
    for (const entry of window.lines) out.push(formatWindowLine(window.path, entry));
  });
  return out;
}

function errorResponse(error, args) {
  const code = error.code || 'UNEXPECTED_ERROR';
  const guidance = {
    INVALID_PATH: 'Use a relative path inside the project directory.',
    INVALID_PATTERN: 'Fix the regular expression, or pass "fixedStrings": true to search for the literal text.'
  }[code];
  return JSON.stringify({
    status: 'error',
    code,
    message: `grep failed: ${error.message}`,
    ...(guidance ? { guidance } : {}),
    path: args?.path,
    pattern: args?.pattern
  });
}

const { definition, execute } = defineTool({
  name: 'grep',
  description:
    'Search file contents across the project and return matches as "path:line: text" lines wrapped in <grep ...> tags, optionally with surrounding context lines (path-line- text). Use it to discover where a symbol, string or pattern lives before reading a file. Skips node_modules, .git, vendor and agent by default, skips binary files, and accepts include/exclude globs.',
  parameters: {
    properties: {
      pattern: {
        type: 'string',
        description: 'Regular expression to search for. Set "fixedStrings": true to search for literal text.'
      },
      path: {
        type: 'string',
        description: 'File or directory to search. Defaults to the project root (".").'
      },
      include: {
        type: 'string',
        description: 'Glob or comma-separated globs a file must match, e.g. "*.js" or "app/**/*.js,utils/**/*.js".'
      },
      exclude: {
        type: 'string',
        description: 'Glob or comma-separated globs that skip a file, e.g. "*.test.js".'
      },
      ignoreCase: {
        type: 'boolean',
        description: 'Case-insensitive search (default false).'
      },
      fixedStrings: {
        type: 'boolean',
        description: 'Treat "pattern" as literal text instead of a regular expression (default false).'
      },
      filesOnly: {
        type: 'boolean',
        description: 'Return only the paths that contain a match, without the matching lines (default false).'
      },
      before: {
        type: 'integer',
        description: `Number of context lines to return before each match (default 0, capped at ${MAX_CONTEXT_LINES}). They are printed as "path-line- text".`
      },
      after: {
        type: 'integer',
        description: `Number of context lines to return after each match (default 0, capped at ${MAX_CONTEXT_LINES}). They are printed as "path-line- text".`
      },
      maxResults: {
        type: 'integer',
        description: `Maximum matching lines to return (default ${DEFAULT_MAX_RESULTS}). Context lines do not count towards this cap.`
      }
    },
    required: ['pattern']
  },
  async execute(args) {
    try {
      const pattern = args.pattern;
      if (typeof pattern !== 'string' || pattern === '') {
        const error = new Error('a non-empty "pattern" string is required.');
        error.code = 'INVALID_PATTERN';
        throw error;
      }

      const regexp = buildSearchRegExp(pattern, {
        ignoreCase: args.ignoreCase === true,
        fixedStrings: args.fixedStrings === true
      });
      const source = regexp.source;
      const flags = regexp.flags;

      const maxResults = Number.isInteger(args.maxResults) && args.maxResults > 0
        ? args.maxResults
        : DEFAULT_MAX_RESULTS;

      const before = normalizeContextLines(args.before);
      const after = normalizeContextLines(args.after);

      const { files, truncated: walkTruncated } = listProjectFiles({
        startPath: args.path,
        include: args.include,
        exclude: args.exclude
      });

      const matches = [];
      const windows = [];
      const matchedFiles = [];

      for (const file of files) {
        if (matches.length >= maxResults) break;
        const lines = readSearchableLines(file);
        if (!lines) continue;
        const hits = findMatches(lines, { source, flags, remaining: maxResults - matches.length });
        if (hits.length === 0) continue;
        matchedFiles.push(file);
        for (const hit of hits) matches.push({ path: file, ...hit });
        for (const window of buildContextWindows(lines, hits, { before, after })) {
          windows.push({ path: file, ...window });
        }
      }

      if (matches.length > maxResults) matches.length = maxResults;
      const truncated = walkTruncated || matches.length >= maxResults;

      const tag = [
        `<grep pattern="${pattern.replace(/"/g, '\\"')}"`,
        `path="${displayPath(args.path)}"`,
        `matches=${matches.length}`,
        `files=${matchedFiles.length}${truncated ? ' truncated=true' : ''}`,
        ...(before > 0 ? [`before=${before}`] : []),
        ...(after > 0 ? [`after=${after}`] : [])
      ].join(' ');
      const open = `${tag}>`;

      if (matches.length === 0) {
        return [open, '(no matches)', '</grep>'].join('\n');
      }

      const body = args.filesOnly === true
        ? matchedFiles.join('\n')
        : renderWindows(windows).join('\n');

      return [open, body, '</grep>'].join('\n');
    } catch (error) {
      return errorResponse(error, args);
    }
  }
});

export { definition, execute };