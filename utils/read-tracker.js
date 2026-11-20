import fs from 'fs';
import { resolveProjectPath, projectRelativePath } from './path-safety.js';

/**
 * What the model has *read*, so a write cannot quietly clobber a change it never saw.
 *
 * The backlog entry:
 *
 * > keep track of file read operations, if the model tries to write and the file has
 * > been touched / edit time has changed, refuse to write / patch and ask the model to
 * > call read first then try to edit after learning what changed
 *
 * A read is recorded as a **fingerprint** of the bytes that were handed over — the
 * modification time and the size — keyed by the project-relative path. Before a write
 * or a patch the file is fingerprinted again: the same pair means the model's view is
 * still the file on disk, a different one means someone else touched it (the user in an
 * editor, another tool, a previous turn) and the write is refused with `STALE_READ`
 * until the model re-reads.
 *
 * Four rules keep the guard honest instead of annoying:
 *
 *  - **only a file the model really read is guarded.** A file it never read, and a file
 *    that does not exist yet (a new file), are written as before: there is no stale view
 *    to protect, and inventing one would refuse every legitimate create.
 *  - **the read is the model's, and the write clears it.** A successful write or patch
 *    forgets the entry, because the bytes on disk are now exactly what the model just
 *    supplied.
 *  - **the tracking files are out of scope.** `task.md` and `implementation_plan.md` are
 *    rewritten whole by `update_task` (`utils/tracking-fence.js`), so a read of one is
 *    routinely followed by a harness write; the fence already answers for them.
 *  - **the state is host state, never a chunk.** It lives in this module's `Map`, so it
 *    costs no context and is not persisted: a resumed session starts with no recorded
 *    reads and therefore guards nothing, which is the safe direction (a refusal needs a
 *    recorded read to exist).
 *
 * Pure bookkeeping around `fs`, so the whole rule is unit testable: `fingerprint()`
 * takes a path, `readDrift()` compares, and nothing here throws — an unusable path is
 * simply not tracked.
 */

/** The reads the model has performed: project-relative path -> `{ mtimeMs, size, at }`. */
const reads = new Map();

/** The path as a key: POSIX-relative, or `null` when the path is not usable. */
export function readKey(path) {
  try {
    return projectRelativePath(path);
  } catch {
    return null;
  }
}

/**
 * The fingerprint of the bytes on disk right now, or `null` when there is no file
 * there. Symlinks are followed: what matters is the content the model would get.
 */
export function fingerprint(path) {
  const key = readKey(path);
  if (key === null) return null;
  try {
    const stat = fs.statSync(resolveProjectPath(key));
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

/** Record that the model has just read `path`. Returns the entry, or `null`. */
export function recordRead(path, { at = Date.now() } = {}) {
  const key = readKey(path);
  if (key === null) return null;
  const current = fingerprint(key);
  if (current === null) return null;
  const entry = { path: key, ...current, at };
  reads.set(key, entry);
  return entry;
}

/** Forget one path: the model's view of it is no longer claimed to be current. */
export function forgetRead(path) {
  const key = readKey(path);
  if (key === null) return false;
  return reads.delete(key);
}

/**
 * Compare a recorded read with the file on disk.
 *
 * @returns {{tracked: boolean, stale: boolean, path: string|null, reason: string|null,
 *   recorded: object|null, current: object|null}}
 *   `reason` is `'modified'` (time or size moved) or `'gone'` (the file was removed).
 */
export function readDrift(path) {
  const key = readKey(path);
  const recorded = key === null ? null : reads.get(key) || null;
  if (!recorded) {
    return { tracked: false, stale: false, path: key, reason: null, recorded: null, current: null };
  }
  const current = fingerprint(key);
  if (current === null) {
    return { tracked: true, stale: true, path: key, reason: 'gone', recorded, current: null };
  }
  const changed = current.mtimeMs !== recorded.mtimeMs || current.size !== recorded.size;
  return {
    tracked: true,
    stale: changed,
    path: key,
    reason: changed ? 'modified' : null,
    recorded,
    current,
  };
}

/**
 * The refusal a write or a patch into a stale file answers with, or `null` when the
 * write may go ahead. The message names what moved and the tool that shows the new
 * bytes, because the model has to re-read before it can write.
 *
 * Only a **modified** file is refused. A file that was *removed* after the read is left
 * to the write itself: there is no unseen content to clobber, and sending the model to
 * re-read a path that no longer exists would be a dead end.
 */
export function staleWriteRefusal(path, { isToolOwned = () => false } = {}) {
  if (isToolOwned(path)) return null;
  const drift = readDrift(path);
  if (drift.reason !== 'modified') return null;

  return {
    status: 'error',
    code: 'STALE_READ',
    path: drift.path,
    reason: drift.reason,
    readAt: drift.recorded.at,
    recordedBytes: drift.recorded.size,
    currentBytes: drift.current.size,
    message: `Refusing to write: ${drift.path} changed on disk after you read it`
      + ` (${drift.recorded.size} bytes -> ${drift.current.size} bytes). Nothing was changed.`,
    guidance: `Call read_file (or hint_file) on ${drift.path} to see the current bytes, then retry the write.`,
  };
}

/** A snapshot of what is tracked (tests and diagnostics only). */
export function trackedReads() {
  return new Map(reads);
}

/** Drop every recorded read (a fresh session, or a test that wants a clean slate). */
export function clearReads() {
  reads.clear();
}
