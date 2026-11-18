import { writeFileVerified } from '../utils/file-io.js';
import { defineTool } from '../utils/tool-schema.js';

/**
 * Overwrite a file with verified, atomic writes (see utils/file-io.js).
 */

const { definition, execute } = defineTool({
  name: 'write_file',
  description: 'Write content to a file, overwriting existing content. The write is atomic and verified byte-for-byte before success is reported.',
  parameters: {
    properties: {
      path: {
        type: 'string',
        description: 'The path to the file to write'
      },
      content: {
        type: 'string',
        description: 'The content to write to the file'
      }
    },
    required: ['path', 'content']
  },
  async execute(args) {
    try {
      const result = writeFileVerified(args.path, args.content);
      return JSON.stringify({
        status: 'success',
        path: args.path,
        bytes: result.bytes,
        created: result.created,
        verified: true,
        message: `Successfully wrote ${result.bytes} bytes to ${args.path}${result.created ? ' (new file)' : ''}.`
      });
    } catch (error) {
      const code = error.code || 'UNEXPECTED_ERROR';
      let guidance = null;
      if (code === 'INVALID_PATH') guidance = 'Use a relative path inside the project directory.';
      if (code === 'INVALID_CONTENT') guidance = 'The "content" argument must be a string.';
      return JSON.stringify({
        status: 'error',
        code,
        message: `write_file failed: ${error.message}`,
        ...(guidance ? { guidance } : {}),
        path: args?.path
      });
    }
  }
});

export { definition, execute };
