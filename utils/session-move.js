import fs from 'fs';

import { sessionId } from './session-format.js';
import { sessionPath, SESSION_DIR } from './session-store.js';
import { resolveProjectPath } from './path-safety.js';

/**
 * Moving a session forward, on disk (`docs/runtime/session-version`).
 *
 * An upgrade does two things at once, and both are why it lives in the store rather than
 * in a command:
 *
 *  1. **it rewrites the pin**, so the conversation now belongs to the running build; and
 *  2. **it gives the session a current id**, so it sorts first in the listing and
 *     `--continue` finds it. Sessions sort newest-first *by id*, so a fresh id is the
 *     whole of "make this the latest" — no index, no extra field.
 *
 * The folder is **renamed, not copied**. Everything a session owns is already inside
 * `agent/sessions/<id>/` — the record, the conversation log, the chunkpaction captures
 * and the tracking pair — so one `renameSync` moves all of it, byte for byte, and there
 * is never a moment when two folders disagree about which is live.
 *
 * Two orderings are deliberate and load-bearing:
 *
 *  - **Rename first, then write.** Writing the new pin through a move means a crash
 *    between the steps leaves a session at its new id with the old pin (still openable by
 *    the version that owns it) rather than at the old id with the new pin (openable by
 *    nobody's neighbour — the older build that could open it is now refused).
 *  - **Never across an existing target.** A name collision aborts before anything moves,
 *    so an upgrade cannot silently overwrite a conversation that already lives there.
 *
 * @see docs/runtime/session-version
 */

/** The oldest layout kept a session as `<id>.json`; that file moves beside the rename. */
function legacyFile(id, dir) {
  try {
    return resolveProjectPath(`${String(dir ?? SESSION_DIR).replace(/\/+$/, '')}/${id}.json`);
  } catch {
    return null;
  }
}

/**
 * Move one session to a fresh id, keeping every file it owns.
 *
 * @param {string} from the current session id
 * @param {{dir?: string, now?: Date, id?: string}} [options] `id` overrides the new name
 * @returns {{from: string, to: string, folder: string}} the move, for the command to report
 * @throws {Error} `UNKNOWN_SESSION` when the source is missing, `TARGET_EXISTS` on a collision
 */
export function moveSession(from, { dir = SESSION_DIR, now = new Date(), id = null } = {}) {
  const source = sessionPath(from, { dir });
  const sourceFolder = resolveProjectPath(source.slice(0, source.lastIndexOf('/')));
  if (!fs.existsSync(sourceFolder)) {
    const error = new Error(`No session stored at ${sourceFolder}.`);
    error.code = 'UNKNOWN_SESSION';
    throw error;
  }

  const to = id ?? sessionId(now instanceof Date ? now : new Date(now));
  if (to === from) return { from, to, folder: sourceFolder };

  const target = sessionPath(to, { dir });
  const targetFolder = resolveProjectPath(target.slice(0, target.lastIndexOf('/')));
  if (fs.existsSync(targetFolder)) {
    const error = new Error(`A session already exists at ${targetFolder}; refusing to overwrite it.`);
    error.code = 'TARGET_EXISTS';
    throw error;
  }

  fs.renameSync(sourceFolder, targetFolder);

  // The pre-folder layout's flat file, if a very old tree still has one for this id: it is
  // a second copy of the same conversation, and leaving it behind would make the old id
  // list a session that has already moved.
  const stale = legacyFile(from, dir);
  if (stale && fs.existsSync(stale)) {
    try {
      fs.renameSync(stale, `${targetFolder}.json`);
    } catch {
      // The folder is already the live record; a flat file nobody reads any more must not
      // fail an upgrade that has otherwise succeeded.
    }
  }

  return { from, to, folder: targetFolder };
}