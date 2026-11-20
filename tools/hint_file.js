import fs from 'fs';
import { resolveProjectPath, projectRelativePath } from '../utils/path-safety.js';
import { recordRead } from '../utils/read-tracker.js';
import { defineTool } from '../utils/tool-schema.js';
import {
  MAX_HINT_CHARS,
  MAX_LINE_CHARS,
  hintFileText,
  hintSavings,
} from '../utils/file-hint.js';
import { lineNumberAtOffset } from './read_file.js';

/**
 * `hint_file` — read a file's *sketch* instead of its bytes.
 *
 * The backlog entry:
 *
 * > a new hint_file tool that is very similar to how read works, with the exception
 * > that all tabs and multiple continuous new lines are removed. long lines are
 * > truncated as well leaving a ...[N chars after] so the model can hint file contents
 * > without risking super long lines congesting the context
 *
 * So it is `read_file` with the same paging (a character `offset`, a `limit`, a
 * negative offset counting from the end) and the same delimited output, and one
 * difference: what comes back is **lossy by construction**
 * (`utils/file-hint.js#hintFileText`). It is the tool for "what is in here?" when the
 * exact bytes do not matter yet; `read_file` remains the tool for the bytes, and the
 * delimiter says `hint` so the two can never be confused in a transcript.
 *
 * Everything that must not be lossy stays exact: the path goes through the same
 * sandbox as every other file tool (`resolveProjectPath`), the page is cut on the
 * characters the caller asked for, and the delimiter reports the line range, the
 * characters returned and the characters the page really held — so the model knows
 * both what it got and what it is missing.
 */

/** Build the opening tag of a hint. */
export function hintTag({ path, from, to, lines, chars, of, truncated }) {
  const range = [
    Number.isInteger(from) ? `from=${from}` : null,
    Number.isInteger(to) ? `to=${to}` : null,
  ].filter(Boolean).join(' ');
  const size = [`lines=${lines}`, `chars=${chars}`, `of=${of}`];
  const attributes = [range, ...size, truncated ? 'truncated=true' : null].filter(Boolean).join(' ');
  return `<hint path="${path}" ${attributes}>`;
}

/** Wrap a sketched page in the `<hint>` delimiter. */
export function wrapHint({ path, text, from, to, lines, chars, of, truncated }) {
  return [hintTag({ path, from, to, lines, chars, of, truncated }), text, '</hint>'].join('\n');
}

function errorResponse(error, args) {
  const code = error?.code === 'ENOENT'
    ? 'NOT_FOUND'
    : (error?.code || 'UNEXPECTED_ERROR');
  const guidance = {
    INVALID_PATH: 'Use a relative path inside the project directory.',
    NOT_FOUND: 'Check the path; hint_file reads one existing file, not a glob or a directory.',
  }[code];
  return JSON.stringify({
    status: 'error',
    code,
    message: `hint_file failed: ${error.message}`,
    ...(guidance ? { guidance } : {}),
    path: args?.path,
  });
}

const { definition, execute } = defineTool({
  name: 'hint_file',
  description:
    'Read a *sketch* of one file, like read_file but lossy on purpose: tabs become spaces, runs of blank lines collapse to one, and long lines are cut with a "...[N chars after]" marker. Supports the same paging (offset/limit, negative offset counts from the end) and returns the page inside <hint path="..."> ... </hint> tags carrying the line range, the characters returned and the characters the page held. Use it to see what a file is about without spending the context a full read costs; use read_file when the exact bytes matter (a patch, a diff, a line to match).',
  parameters: {
    properties: {
      path: {
        type: 'string',
        description: 'The project-relative path of the file to sketch.',
      },
      offset: {
        type: 'integer',
        description: 'Character offset to start from. Positive counts from the beginning (default: 0); negative counts from the end of the file.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of characters of the file to take as the page (no default, the rest of the file is used).',
      },
      lineNumbers: {
        type: 'boolean',
        description: 'Prepend line numbers to the hinted lines (default false: a hint is compact, and read_file gives exact numbered lines).',
      },
      maxLineChars: {
        type: 'integer',
        description: `How long a line may be before it is cut (default ${MAX_LINE_CHARS}).`,
      },
      maxChars: {
        type: 'integer',
        description: `Total character budget of the hint (default ${MAX_HINT_CHARS}); the rest is replaced by a "...[N chars after]" marker.`,
      },
    },
    required: ['path'],
  },
  async execute(args) {
    try {
      const rawPath = args.path;
      const relativePath = projectRelativePath(rawPath);
      const fullContent = fs.readFileSync(resolveProjectPath(rawPath), 'utf-8');
      // A hint is a read too: the model has seen a sketch of these bytes, so a write
      // into a file that moved afterwards is refused (utils/read-tracker.js).
      recordRead(relativePath);
      const fileSize = fullContent.length;
      const fileLines = fullContent === '' ? 0 : fullContent.split('\n').length;

      let offset = Number.isInteger(args.offset) ? args.offset : 0;
      const limit = Number.isInteger(args.limit) && args.limit >= 0 ? args.limit : undefined;

      // The same paging read_file offers, so a hint can be asked for one region.
      if (offset < 0) offset = Math.max(0, fileSize + offset);
      const start = Math.min(offset, fileSize);
      const page = limit !== undefined
        ? fullContent.substring(start, start + limit)
        : fullContent.substring(start);

      const from = lineNumberAtOffset(fullContent, start);
      const hint = hintFileText(page, {
        ...(Number.isInteger(args.maxLineChars) && args.maxLineChars > 0 ? { maxLineChars: args.maxLineChars } : {}),
        ...(Number.isInteger(args.maxChars) && args.maxChars > 0 ? { maxChars: args.maxChars } : {}),
      });
      const pageLines = page === '' ? 0 : page.split('\n').length;
      const to = from + Math.max(0, pageLines - 1);
      const savings = hintSavings(page, hint.text);

      const body = args.lineNumbers === true
        ? hint.text
          .split('\n')
          .map((line, i) => String(from + i).padStart(6) + '  ' + line)
          .join('\n')
        : hint.text;

      const truncated = hint.truncated || savings.savedChars > 0;
      return wrapHint({
        path: relativePath,
        text: body,
        from,
        to,
        lines: pageLines === fileLines ? `${hint.lines}` : `${hint.lines}/${fileLines}`,
        chars: savings.after,
        of: savings.before,
        truncated,
      });
    } catch (error) {
      return errorResponse(error, args);
    }
  },
});

export { definition, execute };
