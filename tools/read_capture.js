import { defineTool } from '../utils/tool-schema.js';
import { getCapture } from '../utils/capture-store.js';
import { selectCapture, CaptureRangeError, DEFAULT_CAPTURE_PAGE, DEFAULT_MAX_MATCHES } from '../utils/capture-window.js';
import { renderYamlHeader, OUTPUT_DELIMITER } from '../utils/command-output.js';

/**
 * `read_capture` — page or scan the full output of a command that answered truncated.
 *
 * A command document that says `truncated: true` carries a `capture: <id>` handle: the
 * whole stream stayed in memory (`utils/capture-store.js`) instead of being written to
 * disk, because command output is attacker-influenced text and nothing should be able
 * to execute it later. This tool is how the model reaches it — the file-like half of
 * the same interface `read_file` and `grep` offer, over a handle instead of a path:
 *
 *   read_capture({ capture: 2, offset: 400, limit: 100 })   // a page, numbered
 *   read_capture({ capture: 2, pattern: 'FAIL|✗|Error' })   // the lines that matter
 *
 * A capture is **short-lived**: it expires as soon as the model moves on to a batch
 * that does not read one, so inspection is the next action, not a later one. An expired
 * handle is reported as `CAPTURE_EXPIRED`, never as an empty page.
 */

const { definition, execute } = defineTool({
  name: 'read_capture',
  description:
    'Page or scan the full output of a command whose result was truncated. When a command document says "truncated: true" it carries a "capture" handle; pass it here with "offset"/"limit" to read a numbered page, or with "pattern" to get only the matching lines (a test failure, an error). The capture lives in memory and expires as soon as you use another tool, so read it in your next action.',
  parameters: {
    properties: {
      capture: {
        type: 'integer',
        description: 'The handle the command document reported as "capture".'
      },
      offset: {
        type: 'integer',
        description: 'First line of the page, 0-based. A negative value counts from the end of the capture, so -50 starts 50 lines before the end.'
      },
      limit: {
        type: 'integer',
        description: `How many lines to return (default ${DEFAULT_CAPTURE_PAGE}, capped at 1000).`
      },
      pattern: {
        type: 'string',
        description: 'Return only the lines matching this regular expression, numbered. Takes precedence over offset/limit.'
      },
      ignoreCase: {
        type: 'boolean',
        description: 'Case-insensitive pattern match (default false).'
      },
      fixedStrings: {
        type: 'boolean',
        description: 'Treat "pattern" as literal text instead of a regular expression (default false).'
      },
      maxMatches: {
        type: 'integer',
        description: `Maximum matching lines to return (default ${DEFAULT_MAX_MATCHES}).`
      }
    },
    required: ['capture']
  },
  async execute(args) {
    const entry = getCapture(args.capture);
    if (!entry) {
      return JSON.stringify({
        status: 'error',
        code: 'CAPTURE_EXPIRED',
        capture: args.capture,
        message: `Capture ${args.capture} is no longer in memory: a capture expires as soon as another tool is used.`,
        guidance: 'Re-run the command with head/tail to see the part you need, or read the capture in the same action as the call that produced it.'
      });
    }

    let selected;
    try {
      selected = selectCapture(entry.text, {
        offset: args.offset,
        limit: args.limit,
        pattern: args.pattern,
        ignoreCase: args.ignoreCase === true,
        fixedStrings: args.fixedStrings === true,
        maxMatches: args.maxMatches
      });
    } catch (error) {
      if (error instanceof CaptureRangeError) {
        return JSON.stringify({
          status: 'error',
          code: error.code,
          capture: entry.id,
          message: `read_capture failed: ${error.message}`,
          ...(error.code === 'INVALID_PATTERN'
            ? { guidance: 'Fix the regular expression, or pass "fixedStrings": true to search for the literal text.' }
            : { guidance: `Ask for at most 1000 lines per call; the capture holds ${entry.lines} lines.` })
        });
      }
      throw error;
    }

    const header = renderYamlHeader({
      status: 'success',
      capture: entry.id,
      command: entry.command,
      lines: entry.lines,
      shown: selected.shown,
      truncated: selected.truncated,
      mode: selected.mode,
      from: selected.from,
      to: selected.to,
      matches: selected.matches,
      offset: selected.mode === 'page' ? args.offset : undefined,
      limit: selected.mode === 'page' ? args.limit : undefined,
      pattern: selected.mode === 'scan' ? args.pattern : undefined
    });

    return `${header}\n${OUTPUT_DELIMITER}\n${selected.body}`;
  }
});

export { definition, execute };
