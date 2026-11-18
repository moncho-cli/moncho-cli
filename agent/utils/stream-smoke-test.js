import { MODEL, OLLAMA_URL } from '../../config/constants.js';

// Function to create the request body for streaming
function getRequestMessages() {
  return [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Tell me a short joke. Only respond with one sentence." }
  ];
}

async function callOllamaWithStream() {
  const messages = getRequestMessages();
  
  console.log("Making streaming request to Ollama API...");
  
  try {
    const response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: messages,
        stream: true,  // This enables streaming
        tools: [],     // No tools for this test
        think: false
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    console.log("\nStreaming response:\n");
    
    // Process the streaming response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let chunkCount = 0;
    
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        break;
      }
      
      // Decode the chunk
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          chunkCount++;
          
          // Check if we have content to display
          if (parsed.message && parsed.message.content) {
            process.stdout.write(parsed.message.content);
            fullResponse += parsed.message.content;
          }
          
          // Check if the response is done
          if (parsed.done) {
            console.log("\n\n[Streaming complete]");
            console.log(`Received ${chunkCount} chunks`);
            console.log(`\nTotal response length: ${fullResponse.length} characters`);
          }
        } catch (e) {
          console.error("Error parsing chunk:", e);
        }
      }
    }
    
    return fullResponse;
  } catch (error) {
    console.error("Error making streaming request:", error.message);
    throw error;
  }
}

// Execute the function
callOllamaWithStream().catch(console.error);
