import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function loadTools() {
  const toolsDir = join(__dirname, '..', 'tools');
  const files = fs.readdirSync(toolsDir).filter(f => f.endsWith('.js'));
  
  const tools = [];
  const toolFunctions = {};
  
  for (const file of files) {
    const modulePath = join(toolsDir, file);
    const toolModule = await import(`file://${modulePath}`);
    
    if (toolModule.definition && toolModule.execute) {
      tools.push(toolModule.definition);
      // Map function name to execution function for runtime resolution
      toolFunctions[toolModule.definition.function.name] = toolModule.execute;
    }
  }
  
  return { tools, toolFunctions };
}
