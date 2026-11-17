import fs from 'fs';

export const definition = {
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
};

export async function execute(args) {
  const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
  return fs.readFileSync(parsedArgs.path, 'utf-8');
}
