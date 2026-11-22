import { TASK_FILE, PLAN_FILE } from '../config/constants.js';
import { defineTool } from '../utils/tool-schema.js';
import {
  normalizeTrackingKind, invalidFileRefusal, authorTrackingDraft,
} from '../utils/tracking-draft.js';
import { trackingTemplate } from '../utils/tracking-format.js';

/**
 * `write_plan_md` — the `design` mode's writer (`docs/interface/modes`).
 *
 * A design session authors exactly two documents, the checklist and the plan of its own
 * conversation, and it does it through this tool rather than the generic `write_file`. The
 * point of the separate tool is the argument it **does not have**: there is no `path`. A
 * caller says only *which* of the pair it means, and the location comes from
 * `utils/tracking-store.js`, the one place that decides where a session's pair lives.
 *
 * That is a stronger guarantee than a path check. A policy that reads a path and compares
 * it against a pattern is a rule the model is asked to respect and the gate has to enforce;
 * a tool with no path argument is one the model **cannot** point anywhere else, so `design`
 * cannot write outside its two documents even if the model tries to.
 *
 * The content is re-rendered into the canonical document before it lands
 * (`utils/tracking-format.js`), so a design session can never leave a malformed checklist
 * behind — it can only leave a *draft* that was normalised.
 */

const { definition, execute } = defineTool({
  name: 'write_plan_md',
  description:
    `Author one of this session's two tracking documents — its ${TASK_FILE} checklist or its ${PLAN_FILE} plan — with no path argument at all: a design session writes these two files and nothing else, so the tool names only which of them it means and the location is the harness's. Whatever "content" you pass is re-rendered into the canonical document before it is stored, so a draft is normalised rather than stored verbatim (the reply carries "canonicalised": true and the parsed items).\n\n${PLAN_FILE}:\n\n${trackingTemplate('plan')}\n\n${TASK_FILE}:\n\n${trackingTemplate('task')}\n\nUse update_task for the bookkeeping loop (marking an item done, ticking a step, resetting the plan for the next item); use this tool to author the documents themselves.`,
  parameters: {
    properties: {
      file: {
        type: 'string',
        enum: ['task', 'plan'],
        description: `Which document to author: "task" for ${TASK_FILE}, "plan" for ${PLAN_FILE}. Defaults to "plan".`
      },
      content: {
        type: 'string',
        description: 'The document to store. It is re-rendered into the canonical shape (title, "status:" line, one column-0 "- [ ]" section) before it lands, so a rough draft is fine.'
      }
    },
    required: ['content']
  },
  async execute(args) {
    const kind = normalizeTrackingKind(args.file);
    if (kind === null) return invalidFileRefusal(args.file);
    return authorTrackingDraft({ kind, content: args.content });
  }
});

export { definition, execute };
