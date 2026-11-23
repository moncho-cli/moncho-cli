import { defineTool } from '../utils/tool-schema.js';
import { recordRead } from '../utils/read-tracker.js';
import {
  displayPath,
  listProjectFiles,
  readTextFile
} from '../utils/project-scan.js';
import {
  BLOB_MAX_BYTES_PER_FILE_CEILING,
  BLOB_MAX_FILES_CEILING,
  BLOB_MAX_TOTAL_BYTES_CEILING
} from '../config/constants.js';

/**
 * Fetch one or more files as raw blobs in a single call.
 *
 * Where read_file pages *one* file, blob answers "show me these files" — a path, a
 * directory or a glob — so discovery costs one tool call instead of many. Output is
 * wrapped in <blobs> / <blob> tags carrying the path, byte size and line count.
 */

const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_BYTES_PER_FILE = 40 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 120 * 1024;

/**
 * A requested cap, defaulted when absent and clamped to its ceiling.
 *
 * The default bounds a bare call; the ceiling bounds the *request*, so a model that
 * asks for `maxFiles: 10000` is answered the ceiling instead of a gigantic response.
 * Clamping rather than refusing keeps the call useful — the tag already reports
 * `truncated=true`, so a caller learns it was capped and can narrow the glob.
 */
export function clampCap(value, fallback, ceiling) {
  const requested = Number.isInteger(value) && value > 0 ? value : fallback;
  return Math.min(requested, ceiling);
}

/** True when the argument looks like a glob rather than a literal path. */
export function isGlobPattern(value) {
  return typeof value === 'string' && /[*?]/.test(value);
}

/**
 * Resolve the requested paths into a concrete, ordered file list.
 *
 * A glob `path` is intersected with `include` (both must match); a literal path or
 * directory is narrowed by `include` the usual way.
 *
 * @param {string} path file, directory or glob (`"."` = project root)
 * @param {{include?: string, exclude?: string, maxFiles?: number}} [options]
 * @returns {{files: string[], truncated: boolean}}
 */
export function resolveBlobTargets(path, { include = [], exclude = [], maxFiles = DEFAULT_MAX_FILES } = {}) {
  const request = path === undefined || path === null || path === '' ? '.' : path;
  const asGlob = isGlobPattern(request);
  return listProjectFiles({
    startPath: asGlob ? '.' : request,
    ...(asGlob ? { includeAll: [request, include] } : { include }),
    exclude,
    maxFiles
  });
}

/**
 * Render one blob. Oversized or binary files become a skipped marker; a file that
 * only partly fits the remaining byte budget is truncated and marked.
 */
function renderBlob(relativePath, { maxBytesPerFile, remainingBytes }) {
  const read = readTextFile(relativePath, maxBytesPerFile);
  if (!read) {
    return {
      text: `<blob path="${relativePath}" skipped="binary-or-too-large" />`,
      bytes: 0,
      truncated: false
    };
  }

  // A blob is a read: the model holds these bytes, so a later write into a file that
  // changed since is refused (utils/read-tracker.js).
  recordRead(relativePath);

  let content = read.content;
  let bytes = read.bytes;
  let truncated = false;
  if (bytes > remainingBytes) {
    content = content.slice(0, Math.max(0, remainingBytes));
    bytes = content.length;
    truncated = true;
  }

  const lines = content === '' ? 0 : content.split('\n').length;
  const body = content.endsWith('\n') ? content.slice(0, -1) : content;
  const attributes = [
    `path="${relativePath}"`,
    `bytes=${bytes}`,
    `lines=${lines}`,
    ...(truncated ? ['truncated=true'] : [])
  ].join(' ');

  return {
    text: [`<blob ${attributes}>`, body, '</blob>'].join('\n'),
    bytes,
    truncated
  };
}

function errorResponse(error, args) {
  const code = error.code || 'UNEXPECTED_ERROR';
  const guidance = {
    INVALID_PATH: 'Use a relative path or glob inside the project directory.',
    NOT_FOUND: 'Check the path, or call blob with a directory or glob such as "utils/*.js".'
  }[code];
  return JSON.stringify({
    status: 'error',
    code,
    message: `blob failed: ${error.message}`,
    ...(guidance ? { guidance } : {}),
    path: args?.path
  });
}

const { definition, execute } = defineTool({
  name: 'blob',
  description:
    `Fetch one or more files as raw blobs in a single call. Accepts a file path, a directory or a glob (e.g. "utils/*.js"), and returns each file wrapped in <blob path="..." bytes=... lines=...> tags. Skips binary files with a marker and truncates oversized ones instead of failing. Narrow the call with include/exclude rather than raising the caps: maxFiles, maxBytesPerFile and maxTotalBytes are clamped to hard ceilings (${BLOB_MAX_FILES_CEILING} files, ${BLOB_MAX_TOTAL_BYTES_CEILING} bytes in total), and a call that hits one reports truncated=true. Use it to read several related files at once; use read_file for a paged single-file read.`,
  parameters: {
    properties: {
      path: {
        type: 'string',
        description: 'File path, directory or glob to fetch. Defaults to the project root (".").'
      },
      include: {
        type: 'string',
        description: 'Glob or comma-separated globs a file must match, e.g. "*.js". Combined with a glob "path" by AND.'
      },
      exclude: {
        type: 'string',
        description: 'Glob or comma-separated globs that skip a file, e.g. "*.test.js".'
      },
      maxFiles: {
        type: 'integer',
        description: `Maximum number of files to return (default ${DEFAULT_MAX_FILES}).`
      },
      maxBytesPerFile: {
        type: 'integer',
        description: `Maximum bytes read per file (default ${DEFAULT_MAX_BYTES_PER_FILE}).`
      },
      maxTotalBytes: {
        type: 'integer',
        description: `Maximum bytes returned in total (default ${DEFAULT_MAX_TOTAL_BYTES}).`
      }
    },
    required: ['path']
  },
  async execute(args) {
    try {
      const maxFiles = clampCap(args.maxFiles, DEFAULT_MAX_FILES, BLOB_MAX_FILES_CEILING);
      const maxBytesPerFile = clampCap(
        args.maxBytesPerFile,
        DEFAULT_MAX_BYTES_PER_FILE,
        BLOB_MAX_BYTES_PER_FILE_CEILING
      );
      const maxTotalBytes = clampCap(
        args.maxTotalBytes,
        DEFAULT_MAX_TOTAL_BYTES,
        BLOB_MAX_TOTAL_BYTES_CEILING
      );

      const { files, truncated: walkTruncated } = resolveBlobTargets(args.path, {
        include: args.include,
        exclude: args.exclude,
        maxFiles
      });

      if (files.length === 0) {
        const error = new Error(`no files matched ${JSON.stringify(args.path ?? '.')}`);
        error.code = 'NOT_FOUND';
        throw error;
      }

      const blobs = [];
      let totalBytes = 0;
      let truncated = walkTruncated;

      for (const file of files) {
        if (totalBytes >= maxTotalBytes) {
          truncated = true;
          break;
        }
        const blob = renderBlob(file, {
          maxBytesPerFile,
          remainingBytes: maxTotalBytes - totalBytes
        });
        totalBytes += blob.bytes;
        if (blob.truncated) truncated = true;
        blobs.push(blob.text);
      }

      const header = [
        '<blobs',
        `path="${displayPath(args.path)}"`,
        `count=${blobs.length}`,
        `bytes=${totalBytes}${truncated ? ' truncated=true' : ''}>`
      ].join(' ');

      return [header, ...blobs, '</blobs>'].join('\n');
    } catch (error) {
      return errorResponse(error, args);
    }
  }
});

export { definition, execute };
