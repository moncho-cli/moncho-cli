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
import { resolveLinePage } from '../utils/line-page.js';
import { numberLines } from './read_file.js';

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
 * So it is `read_file` with the same paging — a 1-based line `offset`, a `limit` in
 * lines, a negative offset counting back from the end, all through the one shared
 * `utils/line-page.js` — and the same delimited output, with one difference: what comes
 * back is **lossy by construction** (`utils/file-hint.js#hintFileText`). It is the tool
 * for "what is in here?" when the exact bytes do not matter yet; `read_file` remains the
 * tool for the bytes, and the delimiter says `hint` so the two can never be confused in
 * a transcript.
 *
 * Everything that must not be lossy stays exact: the path goes through the same sandbox
 * as every other file tool (`resolveProjectPath`), the page is cut on whole lines, and the
 * delimiter reports the line range, the characters returned and the characters the page
 * really held — so the model knows both what it got and what it is missing.
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
    'Read a *sketch* of one file, like read_file but lossy on purpose: tabs become spaces, runs of blank lines collapse to one, and long lines are cut with a "...[N chars after]" marker. Same paging, counted in LINES (offset is a 1-based line number, a negative one counting back from the end; limit is how many lines), and the page comes back inside <hint path="..."> ... </hint> tags carrying the line range, the characters returned and the characters the page held. Use it to see what a file is about without spending the context a full read costs; use read_file when the exact bytes matter (a patch, a diff, a line to match).',
  parameters: {
    properties: {
      path: {
        type: 'string',
        description: 'The project-relative path of the file to sketch.',
      },
      offset: {
        type: 'integer',
        description: 'Line number to start from, 1-based. Negative values count back from the end of the file. An offset past the end returns an empty page.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of lines to take as the page (no default: the rest of the file is used).',
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

      // The same line band read_file offers, so a hint can be asked for one region and
      // its coordinates mean the same thing in both tools.
      const page = resolveLinePage(fullContent, {
        ...(Number.isInteger(args.offset) ? { offset: args.offset } : {}),
        ...(Number.isInteger(args.limit) ? { limit: args.limit } : {}),
      });

      const hint = hintFileText(page.text, {
        ...(Number.isInteger(args.maxLineChars) && args.maxLineChars > 0 ? { maxLineChars: args.maxLineChars } : {}),
        ...(Number.isInteger(args.maxChars) && args.maxChars > 0 ? { maxChars: args.maxChars } : {}),
      });
      const savings = hintSavings(page.text, hint.text);

      const body = args.lineNumbers === true
        ? numberLines(hint.text, page.from ?? 1)
        : hint.text;

      const truncated = hint.truncated || savings.savedChars > 0;
      return wrapHint({
        path: relativePath,
        text: body,
        from: page.from,
        to: page.to,
        lines: page.lines === page.total ? `${hint.lines}` : `${hint.lines}/${page.total}`,
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