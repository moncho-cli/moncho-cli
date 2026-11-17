import fs from 'fs';

export const definition = {
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
};

export async function execute(args) {
  const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
  fs.writeFileSync(parsedArgs.path, parsedArgs.content);
  return `Successfully wrote to ${parsedArgs.path}`;
}
