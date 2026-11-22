import { TASK_FILE, PLAN_FILE } from '../config/constants.js';
import { MAX_EDITS } from '../utils/edit_lib.js';
import { defineTool } from '../utils/tool-schema.js';
import {
  normalizeTrackingKind, invalidFileRefusal, editTrackingDraft,
} from '../utils/tracking-draft.js';

/**
 * `edit_plan_md` — the `design` mode's editor (`docs/interface/modes`).
 *
 * The companion of `write_plan_md`, and path-free for the same reason: a design session
 * edits its own checklist and plan and nothing else, so the call names *which* document it
 * means and never where it is. `utils/tracking-store.js` answers the location, so this tool
 * has no way to reach a file outside the session's pair even if it were asked to.
 *
 * The edits are the same literal search/replace pairs `edit_file` takes, applied by the
 * same engine (`utils/edit_lib.js`), so a miss comes back with the identical diagnostics —
 * the nearest lines and, when it can tell, why they differ. The one difference is what is
 * stored: the edited text is re-rendered into the canonical document
 * (`utils/tracking-format.js`) before it lands, because `update_task` rewrites these files
 * whole and a document left in a dialect would be repaired by the next tracking call.
 */

const { definition, execute } = defineTool({
  name: 'edit_plan_md',
  description:
    `Change part of one of this session's two tracking documents — its ${TASK_FILE} checklist or its ${PLAN_FILE} plan — by replacing literal text, with no path argument at all: a design session edits these two files and nothing else. Pass "search" (the exact bytes to find, copied verbatim with their indentation) and "replace"; several edits go in "edits": [{ "search", "replace" }] and are applied in order, all-or-nothing (at most ${MAX_EDITS}). The search is literal, never a regular expression, and must match exactly once unless "all": true. A miss is refused with the file's own bytes around the region, so the next call is built from what is really there. The edited text is re-rendered into the canonical document before it is stored.`,
  parameters: {
    properties: {
      file: {
        type: 'string',
        enum: ['task', 'plan'],
        description: `Which document to edit: "task" for ${TASK_FILE}, "plan" for ${PLAN_FILE}. Defaults to "plan".`
      },
      search: {
        type: 'string',
        description: 'The exact text to find, copied verbatim from the document including its indentation. Literal, not a regular expression. Must match exactly once unless "all" is true.',
      },
      replace: {
        type: 'string',
        description: 'The text to put in place of "search". It must differ from "search" (NO_CHANGES otherwise); use "" to delete it.',
      },
      all: {
        type: 'boolean',
        description: 'Replace every occurrence instead of refusing when the search matches more than once. Default false.',
      },
      edits: {
        type: 'array',
        description: `Several edits applied in order, all-or-nothing (at most ${MAX_EDITS}). Each item is { "search", "replace", "all"? }: search must be non-empty and differ from replace. An alternative to a top-level "search"/"replace" pair, never both.`,
        items: {
          type: 'object',
          properties: {
            search: { type: 'string' },
            replace: { type: 'string' },
            all: { type: 'boolean' },
          },
          required: ['search', 'replace'],
        },
      },
    },
    required: []
  },
  async execute(args) {
    const kind = normalizeTrackingKind(args.file);
    if (kind === null) return invalidFileRefusal(args.file);

    const hasEdits = Array.isArray(args.edits) && args.edits.length > 0;
    const hasPair = typeof args.search === 'string' && args.search !== '';
    if (hasEdits && hasPair) {
      return JSON.stringify({
        status: 'error',
        code: 'INVALID_ARGUMENTS',
        message: 'Pass either "edits" or a top-level "search"/"replace" pair, not both.',
      });
    }
    if (!hasEdits && !hasPair) {
      return JSON.stringify({
        status: 'error',
        code: 'INVALID_ARGUMENTS',
        message: 'edit_plan_md needs the text to find: pass "edits": [{ "search", "replace" }] or a top-level "search"/"replace".',
      });
    }

    const edits = hasEdits ? args.edits : [{ search: args.search, replace: args.replace, all: args.all }];
    return editTrackingDraft({ kind, edits });
  }
});

export { definition, execute };
