import fs from 'fs';
import path from 'path';

/**
 * Errors raised by the path sandbox. Kept separate from patch errors so every
 * file tool can report the same, predictable failure shape.
 */
export class PathSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PathSafetyError';
    this.code = code;
  }
}

/**
 * Resolve a user/model supplied path and guarantee it stays inside the current
 * working directory. Absolute paths, `..` traversal and symlinks that point
 * outside the project are rejected.
 *
 * @param {string} input - relative path supplied by a tool caller
 * @returns {string} absolute path that is safe to read/write
 */
export function resolveProjectPath(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new PathSafetyError('INVALID_PATH', 'A non-empty relative path is required.');
  }
  if (path.isAbsolute(input)) {
    throw new PathSafetyError('INVALID_PATH', `Absolute paths are not allowed: ${input}`);
  }

  const root = process.cwd();
  const resolved = path.resolve(root, input);
  const relative = path.relative(root, resolved);

  if (relative === '' || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw new PathSafetyError('INVALID_PATH', `Path escapes the project directory: ${input}`);
  }

  // Walk every existing segment so a symlink cannot smuggle us outside root.
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      const realRoot = fs.realpathSync(root);
      const realTarget = fs.realpathSync(cursor);
      const targetRelative = path.relative(realRoot, realTarget);
      if (targetRelative === '..' || targetRelative.startsWith('..' + path.sep) || path.isAbsolute(targetRelative)) {
        throw new PathSafetyError('INVALID_PATH', `Symlink escapes the project directory: ${input}`);
      }
      cursor = realTarget;
    }
  }

  return resolved;
}

/**
 * Resolve a path and return it as a project-relative, POSIX-style path. Used to
 * build the `<file relative_path="...">` delimiter required by task.md item 7
 * (and to keep tool output stable regardless of the host OS separator).
 *
 * @param {string} input - relative path supplied by a tool caller
 * @returns {string} e.g. "app/conversation-manager.js"
 */
export function projectRelativePath(input) {
  return path.relative(process.cwd(), resolveProjectPath(input)).split(path.sep).join('/');
}
