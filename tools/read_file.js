import fs from 'fs';
import { resolveProjectPath, projectRelativePath } from '../utils/path-safety.js';
import { recordRead } from '../utils/read-tracker.js';
import { defineTool } from '../utils/tool-schema.js';

/**
 * Read a file and return it wrapped in the delimiters required by task.md item 7:
 *
 *   <file relative_path="app/main.js" from=10 to=40 lines=31>
 *   ...content...
 *   </file>
 *
 * The tag makes every read unambiguous for the model (path + page range + size),
 * and `lineNumbers:false` gives byte-exact content suitable for building patches.
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
 * Map a character offset to a 1-based line number in the full file.
 * @param {string} text
 * @param {number} offset
 * @returns {number} line number containing `offset` (1 when offset is 0)
 */
export function lineNumberAtOffset(text, offset) {
  if (offset <= 0) return 1;
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

const { definition, execute } = defineTool({
  name: 'read_file',
  description:
    'Read the contents of a file, with optional offset and limit for paging. Negative offset values count from the end of the file (e.g., -100 starts reading 100 characters from the end). Optionally prepend line numbers (default: true). The result is always delimited by <file relative_path="..."> ... </file> tags.',
  parameters: {
    properties: {
      path: {
        type: 'string',
        description: 'The path to the file to read'
      },
      offset: {
        type: 'integer',
        description: 'Character offset to start reading from. Positive values count from the beginning (default: 0). Negative values count from the end of the file (e.g., -100 starts reading 100 characters from the end).'
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of characters to read (no default, reads entire file if omitted)'
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
    const fileSize = fullContent.length;
    const fileLines = fullContent === '' ? 0 : fullContent.split('\n').length;

    let offset = Number.isInteger(args.offset) ? args.offset : 0;
    const limit = Number.isInteger(args.limit) && args.limit >= 0 ? args.limit : undefined;
    const lineNumbers = args.lineNumbers !== false; // default true

    // Handle negative offset: count from the end of the file
    if (offset < 0) offset = Math.max(0, fileSize + offset);
    const start = Math.min(offset, fileSize);

    const slice = limit !== undefined
      ? fullContent.substring(start, start + limit)
      : fullContent.substring(start);

    if (slice === '') {
      return wrapFileContent({ relativePath, content: '', lines: `0/${fileLines}` });
    }

    const from = lineNumberAtOffset(fullContent, start);
    const returnedLines = slice.split('\n').length;
    const to = from + returnedLines - 1;

    const body = lineNumbers
      ? slice
          .split('\n')
          .map((line, i) => String(from + i).padStart(6) + '  ' + line)
          .join('\n')
      : slice;

    return wrapFileContent({
      relativePath,
      content: body,
      from,
      to,
      lines: returnedLines === fileLines ? `${returnedLines}` : `${returnedLines}/${fileLines}`
    });
  }
});

export { definition, execute };
