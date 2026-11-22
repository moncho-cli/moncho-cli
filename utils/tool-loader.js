import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { hasIntentParameter } from './tool-schema.js';
import { toolResultFailed } from '../app/tool-call-format.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Auto-load every tool in ./tools.
 *
 * Enforces the shared tool-call contract: a tool that does not declare the
 * required `intent` parameter is rejected at load time rather than silently
 * breaking task.md item 6 at runtime.
 *
 * The result hook receives `(name, result, intent, { failed })` so the host loop can
 * print the intent next to the tool output, keep it in the model context, and mark the
 * row with the ✓/✗ the call earned (`app/tool-call-format.js#toolResultFailed`).
 */
export async function loadTools(onToolResult) {
  const toolsDir = join(__dirname, '..', 'tools');
  const files = fs.readdirSync(toolsDir).filter(f => f.endsWith('.js'));

  const tools = [];
  const toolFunctions = {};

  for (const file of files) {
    const modulePath = join(toolsDir, file);
    const toolModule = await import(`file://${modulePath}`);

    if (!toolModule.definition || !toolModule.execute) continue;

    const name = toolModule.definition.function?.name || file;
    if (!hasIntentParameter(toolModule.definition)) {
      throw new Error(
        `Tool "${name}" (${file}) does not declare the required "intent" parameter. ` +
        'Declare tools with defineTool() from utils/tool-schema.js (task.md item 6).'
      );
    }
    if (toolFunctions[name]) {
      throw new Error(`Duplicate tool name "${name}" defined in ${file}.`);
    }

    tools.push(toolModule.definition);

    const originalExecute = toolModule.execute;
    toolFunctions[name] = async (args) => {
      const intent = extractIntent(args);
      let result;
      try {
        result = await originalExecute(args);
      } catch (error) {
        // A handler that throws is a failed call too, and the row must say so: the
        // hook is told before the error is re-thrown for the batch to record as an
        // `[error]` chunk. The hook is a display route, so a throwing one never
        // changes the failure the caller sees.
        if (onToolResult) {
          try {
            onToolResult(name, error?.message ?? String(error), intent, { failed: true });
          } catch { /* a display hook must not mask the tool's own failure */ }
        }
        throw error;
      }
      if (onToolResult) onToolResult(name, result, intent, { failed: toolResultFailed(result) });
      return result;
    };
  }

  return { tools, toolFunctions };
}

/** Best-effort intent extraction for the result hook (never throws). */
function extractIntent(args) {
  try {
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    const intent = parsed && typeof parsed === 'object' ? parsed.intent : null;
    return typeof intent === 'string' && intent.trim() !== '' ? intent.trim() : null;
  } catch {
    return null;
  }
}
