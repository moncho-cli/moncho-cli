import { loadTools } from './utils/tool-loader.js';
import { ConversationManager } from './app/conversation-manager.js';
import { createCLI } from './app/cli.js';

async function main() {
  console.log("Initializing tools...");
  const { tools, toolFunctions } = await loadTools();
  console.log(`Loaded ${tools.length} tools:`, tools.map(t => t.function.name).join(', '));

  console.log("\nChat initialized. Type 'exit' to quit.");

  const cli = createCLI();
  
  // Pass a getter function to conversation manager so it can access the tools list
  const getTools = () => tools;
  const manager = new ConversationManager(toolFunctions, getTools);

  while (true) {
    const userInput = await cli.question("\n> ");

    if (userInput.toLowerCase() === 'exit') {
      console.log("Exiting...");
      break;
    }

    await manager.processInput(userInput);
  }

  cli.close();
}

main().catch(console.error);
