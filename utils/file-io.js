import fs from 'fs';
import path from 'path';
import { resolveProjectPath } from './path-safety.js';

/**
 * Verified file operations shared by harness tooling.
 *
 * The write pattern mirrors utils/patch_lib.js: write to a sibling temp file, read
 * it back, then rename over the target. A tool never reports success unless the
 * bytes on disk match what it intended to write, so task/plan bookkeeping and the
 * TUI cannot silently corrupt project files.
 *
 * The delete is the same idea in the other direction (`deleteFileVerified`): the
 * sandbox decides whether the path may be reached, and success is only reported
 * once the path really is gone. A delete cannot be undone by a retry, so it is the
 * stricter of the two.
 */

export class FileIOError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FileIOError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Atomically write `content` to a project-relative path with read-back verification.
 * @param {string} relativePath
 * @param {string} content
 * @returns {{path: string, bytes: number, created: boolean, verified: true}}
 */
export function writeFileVerified(relativePath, content) {
  if (typeof content !== 'string') {
    throw new FileIOError('INVALID_CONTENT', 'content must be a string.');
  }

  const absPath = resolveProjectPath(relativePath);
  const created = !fs.existsSync(absPath);

  if (created) {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
  }

  const target = created ? absPath : fs.realpathSync(absPath);
  const tempPath = `${target}.moncho-write-${process.pid}-${Date.now()}.tmp`;

  try {
    fs.writeFileSync(tempPath, content, 'utf-8');
    if (!created) fs.chmodSync(tempPath, fs.statSync(target).mode);

    const staged = fs.readFileSync(tempPath, 'utf-8');
    if (staged !== content) {
      throw new FileIOError('VERIFICATION_FAILED', 'Staged file differs from the requested content. Nothing was changed.', {
        expectedBytes: content.length,
        actualBytes: staged.length
      });
    }

    fs.renameSync(tempPath, target);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }

  const readback = fs.readFileSync(target, 'utf-8');
  if (readback !== content) {
    throw new FileIOError(
      'POST_WRITE_VERIFICATION_FAILED',
      'Verification failed after writing: the file on disk does not match the requested content.',
      { expectedBytes: content.length, actualBytes: readback.length }
    );
  }

  return { path: relativePath, bytes: content.length, created, verified: true };
}

/** Read a project-relative text file, or return null when it does not exist. */
export function readFileIfExists(relativePath) {
  const absPath = resolveProjectPath(relativePath);
  if (!fs.existsSync(absPath)) return null;
  return fs.readFileSync(absPath, 'utf-8');
}

/**
 * Delete one project-relative file, and prove it is gone.
 *
 * The sandbox is the same one every file tool uses (`resolveProjectPath`), so a
 * delete can never leave the project tree. Because a delete cannot be undone by
 * retrying the call, the checks are deliberately explicit instead of optimistic:
 *
 *  - a path that does not exist is `NOT_FOUND`, never a silent success;
 *  - a **directory** is `IS_DIRECTORY`: this removes one file, never a tree;
 *  - a fifo/socket/device is `NOT_A_FILE`. A **symlink** is allowed: unlinking the
 *    link is exactly the requested operation, and the link's target is never
 *    touched — which is also why the entry is inspected with `lstatSync`.
 *
 * @param {string} relativePath
 * @returns {{path: string, bytes: number, deleted: true, verified: true}}
 */
export function deleteFileVerified(relativePath) {
  const absPath = resolveProjectPath(relativePath);
  if (!fs.existsSync(absPath)) {
    throw new FileIOError('NOT_FOUND', `There is no file at ${relativePath} to delete.`, { path: relativePath });
  }

  const stats = fs.lstatSync(absPath);
  if (stats.isDirectory()) {
    throw new FileIOError('IS_DIRECTORY', `${relativePath} is a directory, and delete_file removes one file.`, {
      path: relativePath
    });
  }
  if (!stats.isFile() && !stats.isSymbolicLink()) {
    throw new FileIOError('NOT_A_FILE', `${relativePath} is not a regular file.`, { path: relativePath });
  }

  fs.unlinkSync(absPath);
  if (fs.existsSync(absPath)) {
    throw new FileIOError(
      'POST_DELETE_VERIFICATION_FAILED',
      `Verification failed after deleting: ${relativePath} is still there.`,
      { path: relativePath }
    );
  }

  return { path: relativePath, bytes: stats.size, deleted: true, verified: true };
}
