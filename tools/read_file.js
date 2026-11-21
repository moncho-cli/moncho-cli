import fs from 'fs';
import { resolveProjectPath, projectRelativePath } from '../utils/path-safety.js';
import { recordRead } from '../utils/read-tracker.js';
import { defineTool } from '../utils/tool-schema.js';
import { resolveLinePage } from '../utils/line-page.js';

/**
 * Read a file and return it wrapped in the delimiters required by task.md item 7:
 *
 *   <file relative_path="app/main.js" from=10 to=40 lines=31>
 *   ...content...
 *   </file>
 *
 * The tag makes every read unambiguous for the model (path + page range + size),
 * and `lineNumbers:false` gives byte-exact content suitable for building patches.
 *
 * **The page and the tag are in the same metric.** Both count lines
 * (`utils/line-page.js`): before that they did not — `offset`/`limit` were character
 * counts while `from`/`to`/`lines` were line counts — so the delimiter described a range
 * the model had not been given and could not page with (task-backlog item 63).
 */

/** Build the opening tag for a read result. */
export function fileTag({ relativePath, from, to, lines }) {
  const range = [
    Number.isInteger(from) ? `from=${from}` : null,
    Number.isInteger(to) ? `to=${to}` : null
  ].filter(Boolean).join(' ');
  return `<file relative_path="${relativePath}"${range ? ` ${range}` : ''} lines=${lines}>`;
}

/** Wrap content in the `<file>` delimiter. */
export function wrapFileContent({ relativePath, content, from, to, lines }) {
  return [fileTag({ relativePath, from, to, lines }), content, '</file>'].join('\n');
}

/**
 * Prepend the file's own line numbers to a page, in the same 1-based metric the
 * `from=` attribute reports — the one coordinate a reader can act on.
 */
export function numberLines(text, from = 1) {
  return String(text ?? '')
    .split('\n')
    .map((line, i) => String(from + i).padStart(6) + '  ' + line)
    .join('\n');
}

const { definition, execute } = defineTool({
  name: 'read_file',
  description:
    'Read the contents of a file, with optional offset and limit for paging. Both count LINES, not characters: offset is a 1-based line number (a negative one counts back from the end, so -1 is the last line) and limit is how many lines to return. An offset past the end returns an empty page rather than clamping. Optionally prepend line numbers (default: true). The result is always delimited by <file relative_path="..."> ... </file> tags.',
  parameters: {
    properties: {
      path: {
        type: 'string',
        description: 'The path to the file to read'
      },
      offset: {
        type: 'integer',
        description: 'Line number to start reading from, 1-based. Negative values count back from the end (e.g., -100 starts 100 lines before the last). An offset past the end returns an empty page.'
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of lines to read (no default: reads to the end of the file)'
      },
      lineNumbers: {
        type: 'boolean',
        description: 'Whether to prepend line numbers to each line (default: true). Set to false to return raw content.'
      }
    },
    required: ['path']
  },
  async execute(args) {
    const rawPath = args.path;
    const relativePath = projectRelativePath(rawPath);

    const fullContent = fs.readFileSync(resolveProjectPath(rawPath), 'utf-8');
    // The model now holds these bytes: remember them, so a later write into a file
    // that changed in the meantime is refused (utils/read-tracker.js).
    recordRead(relativePath);

    const page = resolveLinePage(fullContent, {
      ...(Number.isInteger(args.offset) ? { offset: args.offset } : {}),
      ...(Number.isInteger(args.limit) ? { limit: args.limit } : {})
    });

    // Every page is in the file's own lines, so the tag's range and the numbered body
    // cannot disagree — and `total` is the number the next offset is computed from.
    if (page.empty) {
      return wrapFileContent({ relativePath, content: '', lines: `0/${page.total}` });
    }

    const body = args.lineNumbers === false ? page.text : numberLines(page.text, page.from);

    return wrapFileContent({
      relativePath,
      content: body,
      from: page.from,
      to: page.to,
      lines: page.lines === page.total ? `${page.lines}` : `${page.lines}/${page.total}`
    });
  }
});

export { definition, execute };