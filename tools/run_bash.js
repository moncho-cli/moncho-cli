import { ALLOWED_COMMANDS } from '../config/constants.js';
import { execSync } from 'child_process';

export const definition = {
  type: "function",
  function: {
    name: "run_bash",
    description: "Execute a bash command from an approved list",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: `The bash command to execute. Available commands: ${ALLOWED_COMMANDS.join(',')}`
        }
      },
      required: ["command"]
    }
  }
};

export async function execute(args) {
  const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
  const cmd = parsedArgs.command;
  const binary = cmd.trim().split(/\s+/)[0];
  
  if (ALLOWED_COMMANDS.includes(binary)) {
    return execSync(cmd).toString();
  } else {
    return `Error: Command '${binary}' is not in the approved list.`;
  }
}
