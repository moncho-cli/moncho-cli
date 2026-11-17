const fs = require('fs');
const process = require('process');
const readline = require('readline');
const exec = require('child_process').execSync;

const ALLOWED_COMMANDS = [
  'ls',
  'mkdir',
  'pwd',
  'cat',
  'grep',
  'find',
  'echo',
  'date',
  'whoami'
];


const model = "qwen3.6:35b-a3b-q4_K_M";

const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The path to the file to read"
          }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file, overwriting existing content",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The path to the file to write"
          },
          content: {
            type: "string",
            description: "The content to write to the file"
          }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
        name: "run_bash",
        description: "Execute a bash command from an approved list",
        parameters: {
        type: "object",
        properties: {
            command: {
                type: "string",
                description: "The bash command to execute. Available commands: " + ALLOWED_COMMANDS.join(',')
            }
        },
        required: ["command"]
        }
    }
  }
];

async function callOllama(messages) {
  const response = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model,
      messages: messages,
      stream: false,
      tools: tools
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return await response.json();
}

function executeTool(name, args) {
  try {
    const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
    switch (name) {
      case "read_file":
        return fs.readFileSync(parsedArgs.path, 'utf-8');
      case "write_file":
        fs.writeFileSync(parsedArgs.path, parsedArgs.content);
        return `Successfully wrote to ${parsedArgs.path}`;
    case "run_bash":
        const cmd = parsedArgs.command;
        const binary = cmd.trim().split(/\s+/)[0];
        
        if (ALLOWED_COMMANDS.includes(binary)) {
            return exec(cmd).toString();
        } else {
            return `Error: Command '${binary}' is not in the approved list.`;
        }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return `Error executing ${name}: ${error.message}`;
  }
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

  let messages = [];

  console.log("Chat initialized. Type 'exit' to quit.");

  while (true) {
    const userInput = await question("\n> ");

    if (userInput.toLowerCase() === 'exit') {
      console.log("Exiting...");
      break;
    }

    messages.push({ role: "user", content: userInput });

    while (true) {
      try {
        const data = await callOllama(messages);

        if (data.message?.tool_calls) {
          // Handle tool calls
          for (const toolCall of data.message.tool_calls) {
            const functionName = toolCall.function.name;
            const args = toolCall.function.arguments;

            console.log(`\n  -> Calling ${functionName}(${args})`);
            
            // Add the assistant message containing the tool call to history before executing
            messages.push(data.message);
            
            const result = executeTool(functionName, args);
            
            // Add tool result to history
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: result
            });
          }
        } else {
          // Final response (no tools)
          const finalResponse = data.message?.content || "";

          // Add the final assistant message to history so context is preserved for next prompt
          messages.push(data.message);

          fs.writeFileSync("response.md", finalResponse);
          
          console.log("\n--- AI Response ---");
          console.log(finalResponse);
          console.log("----------------------");
          console.log("Response saved to response.md\n");
          break; // Exit inner loop, wait for next user input
        }
      } catch (error) {
        console.error("\nError calling Ollama:", error.message);
        break;
      }
    }
  }

  rl.close();
}

main();
