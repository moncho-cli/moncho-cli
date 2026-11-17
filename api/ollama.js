import { MODEL, OLLAMA_URL } from '../config/constants.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const THINKING_FILE = path.join(__dirname, '..', 'thinking.md');

async function loadSystemPrompt() {
  const promptPath = path.join(__dirname, '..', 'prompt.md');
  try {
    return fs.readFileSync(promptPath, 'utf-8').trim();
  } catch (error) {
    console.warn('Warning: Could not read prompt.md:', error.message);
    return '';
  }
}

async function clearThinkingFile() {
  fs.writeFileSync(THINKING_FILE, '', 'utf-8');
}

let systemPromptCache = null;

export async function callOllama(messages, tools, isStreaming = false) {
  // Load system prompt if not cached or if cache is empty
  if (!systemPromptCache) {
    systemPromptCache = await loadSystemPrompt();
  }

  // Create messages array with system prompt first, then user messages
  const ollamaMessages = [];
  
  if (systemPromptCache) {
    ollamaMessages.push({ role: "system", content: systemPromptCache });
  }
  
  ollamaMessages.push(...messages);

  if (!isStreaming) {
    // Non-streaming call
    const response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: ollamaMessages,
        stream: false,
        tools: tools,
        think: true // Enable thinking for non-streaming as well
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json();
  } else {
    // Streaming call with thinking capture
    const response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: ollamaMessages,
        stream: true,
        tools: tools,
        think: true // Enable thinking mode for streaming
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    
    // Clear the thinking file at the start of streaming
    await clearThinkingFile();

    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        break;
      }
      
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          
          // Ollama streaming with 'think' enabled sends chunks where the message 
          // has a 'thinking' field during the thinking phase.
          if (parsed.message && parsed.message.content) {
            // Check if this chunk is part of the thinking process
            // The presence of 'thinking' field in the message indicates thinking content
            if (parsed.message.thinking) {
              fs.appendFileSync(THINKING_FILE, parsed.message.content, 'utf-8');
            } else {
              // If it's not a thinking chunk, it's the final response
              fullResponse += parsed.message.content;
              process.stdout.write(parsed.message.content);
            }
          }
          
          // If done, we are finished
          if (parsed.done) {
            console.log("\n\n[Streaming complete]");
          }
          
        } catch (e) {
          console.error("Error parsing chunk:", e);
        }
      }
    }

    return fullResponse;
  }
}
