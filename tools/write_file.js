import { writeFileVerified } from '../utils/file-io.js';
import { forgetRead, staleWriteRefusal } from '../utils/read-tracker.js';
import { defineTool } from '../utils/tool-schema.js';
import { canonicalTrackingWrite, isToolOwnedFile, trackingLocationRefusal } from '../utils/tracking-fence.js';
import { hostExecutableRefusal } from '../utils/host-fence.js';

/**
 * Overwrite a file with verified, atomic writes (see utils/file-io.js).
 *
 * A write that names one of the two tracking files is **normalised**: whatever the
 * caller supplied is re-rendered into the canonical document
 * (`utils/tracking-format.js`) before it lands, so `task.md` and
 * `implementation_plan.md` keep their shape no matter who drafts them
 * (`utils/tracking-fence.js`).
 * * A file the model *read* and that changed on disk in the meantime is **refused** with
 * `STALE_READ` (`utils/read-tracker.js`): overwriting it would throw away bytes the
 * model never saw. The refusal names the re-read that clears it, and the tracking files
 * are exempt because `update_task` rewrites them whole.
 */
const { definition, execute } = defineTool({
  name: 'write_file',
  description: 'Write content to a file, overwriting existing content. The write is atomic and verified byte-for-byte before success is reported. A write to task.md or implementation_plan.md is re-rendered in the canonical tracking shape (title, "status:" line, one "- [ ]" section), so a draft is normalised rather than stored verbatim — and only at the path update_task reports for them: anywhere else, including the project root, a tracking name is refused with TRACKING_FILE_NOT_IN_SESSION, because that pair belongs to the conversation.',
  parameters: {
    properties: {
      path: {
        type: 'string',
        description: 'A relative path inside the project. A previously read file must not have changed since that read (STALE_READ), except tool-owned tracking files; host-executable paths are refused.'
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
      // A file the model read and that changed in the meantime is refused: writing now
      // would clobber bytes it never saw (utils/read-tracker.js). The tracking files are
      // exempt — `update_task` owns them and the fence already answers for them.
      const stale = staleWriteRefusal(args?.path, { isToolOwned: isToolOwnedFile });
      if (stale) return JSON.stringify(stale);

      // A tracking name is only a checklist **inside** a session folder, and this is the
      // one writer that could create it anywhere else: a root `task.md` is refused
      // (`utils/tracking-fence.js`), so the harness never puts the pair in the tree.
      const misplaced = trackingLocationRefusal(args.path);
      if (misplaced) return JSON.stringify(misplaced);

      // A path the *host* executes — a git hook, the repo config, the env file the runner
      // sources — is refused before the sandbox even resolves it: inside the project is
      // not the question for these (`utils/host-fence.js`).
      const hostExec = hostExecutableRefusal(args.path);
      if (hostExec) return JSON.stringify(hostExec);

      const tracking = canonicalTrackingWrite(args.path, args.content);
      const content = tracking ? tracking.content : args.content;
      const result = writeFileVerified(args.path, content);
      // The bytes on disk are now the model's own: no stale view is left to guard.
      forgetRead(args.path);
      return JSON.stringify({
        status: 'success',
        path: args.path,
        bytes: result.bytes,
        created: result.created,
        verified: true,
        ...(tracking ? { canonicalised: true, kind: tracking.kind } : {}),
        message: `Successfully wrote ${result.bytes} bytes to ${args.path}${result.created ? ' (new file)' : ''}.`
          + (tracking ? ' The tracking document was re-rendered in its canonical shape.' : '')
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