import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { hasIntentParameter } from './tool-schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Auto-load every tool in ./tools.
 *
 * Enforces the shared tool-call contract: a tool that does not declare the
 * required `intent` parameter is rejected at load time rather than silently
 * breaking task.md item 6 at runtime.
 *
 * The result hook receives `(name, result, intent)` so the host loop can print
 * the intent next to the tool output (and keep it in the model context).
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
      const result = await originalExecute(args);
      if (onToolResult) onToolResult(name, result, intent);
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
