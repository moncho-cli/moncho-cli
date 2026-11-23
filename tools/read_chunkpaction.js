import { defineTool } from '../utils/tool-schema.js';
import { getSession } from '../utils/host.js';
import { readChunkpaction } from '../utils/chunkpaction-store.js';
import { captureIndex, captureText, findCapture, normalizeCaptureId } from '../utils/chunkpaction.js';
import { selectCapture, CaptureRangeError, DEFAULT_CAPTURE_PAGE, DEFAULT_MAX_MATCHES } from '../utils/capture-window.js';
import { renderYamlHeader, OUTPUT_DELIMITER } from '../utils/command-output.js';

/**
 * `read_chunkpaction` — read back the raw chunks a collapsed section replaced.
 *
 * A collapse (`utils/item-collapse.js`) replaces a solved item's section with one
 * deterministic summary, and the summary names a capture id. This is the tool that makes
 * that name resolvable: the raw chunks of the section are kept in the session's own
 * `chunkpaction.json` (`utils/chunkpaction-store.js`), so "if it needs anything it can
 * query back again" is something the model can actually do.
 *
 * It is `read_capture`'s durable sibling, and the difference is the point:
 *
 *   read_capture        an in-memory handle for a command's output, expiring at the next batch
 *   read_chunkpaction   a file in the session folder, still there after a resume
 *
 * The two share the *reading* half — `utils/capture-window.js#selectCapture` pages and
 * scans a string, and `captureText()` renders a capture into one — so a page or a scan
 * over a chunkpaction behaves exactly like one over a command capture.
 *
 * Called with no `capture`, it lists what the session holds: an id, the item it belongs
 * to, when it was taken and how many chunks it has. That is the cheap first move, and it
 * is why the summary can name an id without the model having to guess.
 */

/** The refusal when no session is registered, so there is no folder to read from. */
function noSession() {
  return JSON.stringify({
    status: 'error',
    code: 'NO_SESSION',
    message: 'There is no session, so there is no chunkpaction file to read.',
    guidance: 'This tool reads the captures of the conversation it runs in; a bare call has none.',
  });
}

const { definition, execute } = defineTool({
  name: 'read_chunkpaction',
  description:
    'Read back the raw chunks a collapsed section replaced. A collapsed summary in the conversation names a capture id; pass it here with "offset"/"limit" to read a numbered page of the original chunks, or with "pattern" to get only the matching lines. Called with no "capture" it lists the captures this session holds (id, item, when, how many chunks), which is the cheap way to see what is available. Unlike read_capture, a chunkpaction is stored in the session folder, so it survives a resume.',
  parameters: {
    properties: {
      capture: {
        type: 'integer',
        description: 'The capture id a collapsed summary named, or omit it to list the captures this session holds.'
      },
      offset: {
        type: 'integer',
        description: 'First line of the page, 0-based. A negative value counts from the end, so -50 starts 50 lines before the end.'
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
    required: []
  },
  async execute(args) {
    const id = getSession()?.id;
    if (!id) return noSession();

    const record = readChunkpaction(id);
    const available = captureIndex(record || { captures: [] });

    // No capture named: list what this session holds. A session that never collapsed
    // anything is not an error — it simply has nothing to read back.
    if (args.capture === undefined || args.capture === null || args.capture === '') {
      return renderYamlHeader({
        status: 'success',
        session: id,
        captures: available.length,
        available: available.length > 0 ? available.map((entry) => entry.capture).join(',') : undefined,
      }) + `\n${OUTPUT_DELIMITER}\n` + (available.length === 0
        ? '(no chunkpaction captures: nothing has been collapsed in this session)'
        : available.map((entry) => (
          `capture ${entry.capture}  ${entry.chunks} chunk(s)  ${entry.at || ''}  ${entry.item ? `item: ${entry.item}` : ''}`
        )).join('\n'));
    }

    const entry = findCapture(record, args.capture);
    if (!entry) {
      return JSON.stringify({
        status: 'error',
        code: 'CAPTURE_NOT_FOUND',
        capture: normalizeCaptureId(args.capture),
        message: `This session has no chunkpaction capture ${JSON.stringify(args.capture)}.`,
        ...(available.length > 0 ? { available: available.map((item) => item.capture) } : {}),
        guidance: 'Call read_chunkpaction with no "capture" to list the captures this session holds.',
      });
    }

    let selected;
    try {
      selected = selectCapture(captureText(entry), {
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
          capture: entry.capture,
          message: `read_chunkpaction failed: ${error.message}`,
          ...(error.code === 'INVALID_PATTERN'
            ? { guidance: 'Fix the regular expression, or pass "fixedStrings": true to search for the literal text.' }
            : { guidance: 'Ask for at most 1000 lines per call.' })
        });
      }
      throw error;
    }

    const header = renderYamlHeader({
      status: 'success',
      session: id,
      capture: entry.capture,
      item: entry.item || undefined,
      taken: entry.at || undefined,
      chunks: Array.isArray(entry.chunks) ? entry.chunks.length : 0,
      lines: selected.total,
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
