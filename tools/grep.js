import fs from 'fs';
import { resolveProjectPath } from '../utils/path-safety.js';
import { defineTool } from '../utils/tool-schema.js';
import { displayPath, listProjectFiles, looksBinary } from '../utils/project-scan.js';

/**
 * Search file contents across the project and return `path:line: text` matches.
 *
 * This is the *discovery* companion to read_file: it answers "where does this
 * string live?" without the model having to guess paths or page through files.
 * It never writes, never follows symlinks and never walks node_modules/.git.
 */

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RESULTS = 200;
const MAX_LINE_PREVIEW = 400;

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

/**
 * Collect matching lines for one file.
 * Returns null when the file is unreadable, too large or binary.
 */
export function searchFile(relativePath, { source, flags, remaining }) {
  let buffer;
  try {
    buffer = fs.readFileSync(resolveProjectPath(relativePath));
  } catch {
    return null;
  }
  if (buffer.length > MAX_FILE_BYTES || looksBinary(buffer)) return null;

  const hits = [];
  const lines = buffer.toString('utf-8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!new RegExp(source, flags).test(line)) continue;
    const preview = line.length > MAX_LINE_PREVIEW ? `${line.slice(0, MAX_LINE_PREVIEW)}…` : line;
    hits.push({ line: i + 1, text: preview });
    if (hits.length >= remaining) break;
  }
  return hits;
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
    'Search file contents across the project and return matches as "path:line: text" lines wrapped in <grep ...> tags. Use it to discover where a symbol, string or pattern lives before reading a file. Skips node_modules, .git, vendor and agent by default, skips binary files, and accepts include/exclude globs.',
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
      maxResults: {
        type: 'integer',
        description: `Maximum matching lines to return (default ${DEFAULT_MAX_RESULTS}).`
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

      const { files, truncated: walkTruncated } = listProjectFiles({
        startPath: args.path,
        include: args.include,
        exclude: args.exclude
      });

      const matches = [];
      const matchedFiles = [];

      for (const file of files) {
        if (matches.length >= maxResults) break;
        const hits = searchFile(file, { source, flags, remaining: maxResults - matches.length });
        if (!hits || hits.length === 0) continue;
        matchedFiles.push(file);
        for (const hit of hits) matches.push({ path: file, ...hit });
      }

      if (matches.length > maxResults) matches.length = maxResults;
      const truncated = walkTruncated || matches.length >= maxResults;

      const tag = [
        `<grep pattern="${pattern.replace(/"/g, '\\"')}"`,
        `path="${displayPath(args.path)}"`,
        `matches=${matches.length}`,
        `files=${matchedFiles.length}${truncated ? ' truncated=true' : ''}>`
      ].join(' ');

      if (matches.length === 0) {
        return [tag, '(no matches)', '</grep>'].join('\n');
      }

      const body = args.filesOnly === true
        ? matchedFiles.join('\n')
        : matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join('\n');

      return [tag, body, '</grep>'].join('\n');
    } catch (error) {
      return errorResponse(error, args);
    }
  }
});

export { definition, execute };
