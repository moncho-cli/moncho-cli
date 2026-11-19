import { CONTEXT_MAX_LENGTH } from '../config/constants.js';
import { getContextWindow } from '../utils/host.js';
import { estimateRequestTokens } from '../utils/tokens.js';
import { defineTool } from '../utils/tool-schema.js';

/**
 * `compact_context` (task.md item 8).
 *
 * When the context window (an array of chunks) exceeds CONTEXT_MAX_LENGTH tokens,
 * this tool replaces the older 80% with a single summarised chunk and keeps the
 * newest 20% verbatim. The model-backed summary is produced by the host loop
 * (ConversationManager), which owns the provider connection; the tool therefore
 * either *requests* a compaction (`defer: true`) or performs a deterministic,
 * model-free dry run that reports the exact split.
 */

/**
 * Decide whether a compaction is required and, if so, what it would split.
 * Pure and model-free: safe to call from anywhere.
 */
export function planCompaction(contextWindow, { force = false, dryRun = true } = {}) {
  const maxTokens = contextWindow.maxTokens || CONTEXT_MAX_LENGTH;
  const chunks = contextWindow.chunks || [];
  const estimated = estimateRequestTokens(chunks, contextWindow.getTools?.() || []);

  return {
    required: force || estimated > maxTokens,
    reason: estimated > maxTokens ? 'over-budget' : force ? 'forced' : 'within-budget',
    estimatedTokens: estimated,
    maxTokens,
    chunks: chunks.length,
    dryRun
  };
}

const { definition, execute } = defineTool({
  name: 'compact_context',
  description:
    `Summarise and shrink the conversation context window when it exceeds CONTEXT_MAX_LENGTH (${CONTEXT_MAX_LENGTH}) tokens. The older 80% of the window is replaced by one summary chunk covering original intent, tasks done and things pending; the newest 20% is kept verbatim, and the last message the user wrote inside the summarised block is carried over verbatim so the user's own intent survives.`,
  parameters: {
    properties: {
      force: {
        type: 'boolean',
        description: 'Compact even when the window is still within budget (default false).'
      },
      dryRun: {
        type: 'boolean',
        description: 'Report the planned 80/20 split without calling the model (default true). Set false to actually run the summarisation via the host loop.'
      }
    }
  },
  async execute(args) {
    const contextWindow = getContextWindow();
    if (!contextWindow) {
      return JSON.stringify({
        status: 'error',
        code: 'NO_CONTEXT_WINDOW',
        message: 'No context window is registered with the harness host.'
      });
    }

    const force = args.force === true;
    const dryRun = args.dryRun !== false; // default true: never call the model implicitly
    const plan = planCompaction(contextWindow, { force, dryRun });

    if (!plan.required) {
      return JSON.stringify({
        status: 'skipped',
        code: 'WITHIN_BUDGET',
        message: `Context window still within budget (${contextWindow.usage()}).`,
        ...plan,
        usage: contextWindow.usage()
      });
    }

    // Non-dry runs are executed by the ConversationManager, which owns callOllama.
    return JSON.stringify({
      status: 'requested',
      code: 'COMPACTION_REQUESTED',
      message: 'Compaction needed; the host loop will summarise and replace the older 80% of the window.',
      defer: !dryRun,
      ...plan,
      usage: contextWindow.usage()
    });
  }
});

export { definition, execute };
