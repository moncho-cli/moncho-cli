import { deleteFileVerified, FileIOError } from '../utils/file-io.js';
import { defineTool } from '../utils/tool-schema.js';
import { trackingDeleteRefusal } from '../utils/tracking-fence.js';

/**
 * Delete one file, inside the project and nowhere else.
 *
 * The path goes through the same sandbox every other file tool uses
 * (`utils/path-safety.js#resolveProjectPath`), so an absolute path, a `..`
 * traversal and a symlink pointing out of the tree are all refused before anything
 * is touched — "within the workdir" is not a check this tool performs, it is the
 * property it inherits.
 *
 * The removal itself is `deleteFileVerified()` (`utils/file-io.js`), the mirror of
 * the verified write: it refuses a directory (this removes one file, never a tree)
 * and reports a missing file as an error rather than a silent success, because a
 * delete cannot be undone by retrying.
 *
 * The two tracking files are the one exception on purpose: they belong to
 * `update_task` (`utils/tracking-fence.js`), so a delete that names one is refused
 * with the tool to use instead.
 */

/** The failure codes this tool can explain, with the line that lets the model fix it. */
const GUIDANCE = Object.freeze({
  INVALID_PATH: 'Use a relative path inside the project directory.',
  INVALID_ARGUMENTS: 'Pass `path` as a non-empty relative path string.',
  NOT_FOUND: 'Nothing was changed. Check the path with read_file or blob before deleting.',
  IS_DIRECTORY: 'delete_file removes one file. Name the file itself, not a folder.',
  NOT_A_FILE: 'Only a regular file can be deleted.',
  POST_DELETE_VERIFICATION_FAILED: 'The file was still there after the delete; nothing else was changed.',
});

const { definition, execute } = defineTool({
  name: 'delete_file',
  description: 'Delete one file. The path is resolved through the same sandbox every file tool uses (utils/path-safety.js), so a delete can never leave the project directory: absolute paths, ".." traversal and escaping symlinks are refused. A directory is refused because this removes one file, never a tree, and a missing path is reported as NOT_FOUND instead of a silent success. Success is only reported once the path is really gone (deleteFileVerified).',
  parameters: {
    properties: {
      path: {
        type: 'string',
        description: 'Relative path of the file to delete (must be inside the current directory)',
      },
    },
    required: ['path'],
  },
  async execute(args) {
    try {
      if (typeof args?.path !== 'string' || args.path.trim() === '') {
        throw new FileIOError('INVALID_ARGUMENTS', 'delete_file requires a non-empty relative "path" string.');
      }

      // The tracking files are owned by `update_task`: a delete would take the
      // checklist the session is driving itself from off the disk.
      const fenced = trackingDeleteRefusal(args.path);
      if (fenced) return JSON.stringify(fenced);

      const result = deleteFileVerified(args.path);
      return JSON.stringify({
        status: 'success',
        path: result.path,
        bytes: result.bytes,
        deleted: true,
        verified: true,
        message: `Deleted ${result.path} (${result.bytes} bytes).`,
      });
    } catch (error) {
      const code = error.code || 'UNEXPECTED_ERROR';
      const guidance = GUIDANCE[code];
      return JSON.stringify({
        status: 'error',
        code,
        message: `delete_file failed: ${error.message}`,
        ...(guidance ? { guidance } : {}),
        ...(error.details || {}),
        path: args?.path,
      });
    }
  },
});

export { definition, execute };
