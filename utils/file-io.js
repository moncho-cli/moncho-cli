import fs from 'fs';
import path from 'path';
import { resolveProjectPath } from './path-safety.js';

/**
 * Verified, atomic file writes shared by harness tooling.
 *
 * The pattern mirrors utils/patch_lib.js: write to a sibling temp file, read it
 * back, then rename over the target. A tool never reports success unless the
 * bytes on disk match what it intended to write, so task/plan bookkeeping and
 * the TUI cannot silently corrupt project files.
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
