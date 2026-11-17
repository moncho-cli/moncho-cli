import { callOllama } from '../api/ollama.js';
import fs from 'fs';
import { RESPONSE_FILE } from '../config/constants.js';

export class ConversationManager {
  constructor(toolFunctions, getTools) {
    this.messages = [];
    this.toolFunctions = toolFunctions;
    this.getTools = getTools; // Function that returns current tools array
  }

  /**
   * Creates a simple string representation of the function arguments.
   - If the argument is a short string, number, or boolean (length <= 20), 
     it shows "paramName: value".
   - If the argument is a long string (length > 20), 
     it shows "paramName: string(Nchars)".
   - Otherwise, it shows "paramName: [object Object]" or similar.
   */
  formatArgs(args) {
    let formatted = '';
    
    if (typeof args === 'string') {
      // If args is already a string (single parameter), just format it directly
      if (args.length <= 20) {
        formatted = args;
      } else {
        formatted = `string(${args.length} chars)`;
      }
    } else if (typeof args === 'object' && args !== null) {
      const parts = [];
      for (const [key, value] of Object.entries(args)) {
        let displayValue;
        
        if (typeof value === 'string') {
          if (value.length <= 150) {
            displayValue = value;
          } else {
            displayValue = `string(${value.length} chars)`;
          }
        } else if (typeof value === 'number' || typeof value === 'boolean') {
          displayValue = `${value}`;
        } else {
          displayValue = `[object Object]`;
        }
        
        parts.push(`${key}: ${displayValue}`);
      }
      formatted = parts.join(', ');
    } else {
      formatted = `${args}`;
    }
    
    return formatted;
  }

  async processInput(userInput) {
    this.messages.push({ role: "user", content: userInput });

    while (true) {
      try {
        const data = await callOllama(this.messages, this.getTools());
        
        if (data.message?.tool_calls) {
          await this.handleToolCalls(data.message.tool_calls);
        } else {
          await this.handleFinalResponse(data.message?.content || "");
          break;
        }
      } catch (error) {
        console.error("\nError calling Ollama:", error.message);
        break;
      }
    }
  }

  async handleToolCalls(toolCalls) {
    for (const toolCall of toolCalls) {
      const functionName = toolCall.function.name;
      const args = toolCall.function.arguments;

      console.log(`\n  -> Calling ${functionName}(${this.formatArgs(args)})`);
      
      this.messages.push({ ...toolCall, role: "assistant" });
      
      try {
        const result = await this.toolFunctions[functionName](args);
        
        this.messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result
        });
      } catch (error) {
        this.messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: `Error executing ${functionName}: ${error.message}`
        });
      }
    }
  }

  async handleFinalResponse(content) {
    this.messages.push({ role: "assistant", content });
    
    fs.writeFileSync(RESPONSE_FILE, content);
    
    console.log("\n--- AI Response ---");
    console.log(content);
    console.log("----------------------");
    console.log(`Response saved to ${RESPONSE_FILE}\n`);
  }

  getMessages() {
    return this.messages;
  }

  reset() {
    this.messages = [];
  }
}
