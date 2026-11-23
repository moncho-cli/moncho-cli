import { moveSession } from '../utils/session-move.js';
import { loadSession, writeSession } from '../utils/session-store.js';
import { serializeSession } from '../utils/session-format.js';
import { upgradedPin, runningVersion, latestVersion, canOpenSession } from '../utils/session-version.js';

/**
 * `/upgrade` — move the open session to the running version
 * (`docs/runtime/session-version`).
 *
 * This is the second half of the pin. A session belongs to the build that wrote it, so an
 * older conversation is opened by starting the older payload — and then this command is
 * what carries it forward.
 *
 * Three things happen, in this order, and the order is the design:
 *
 *  1. **the folder is moved to a current id** (`utils/session-move.js`), so the session
 *     sorts first and `--continue` finds it;
 *  2. **the pin and its audit line are written**, so the conversation now belongs to this
 *     version and the old one refuses it from here on;
 *  3. **the process is asked to end** (`close`), because the container is still running
 *     the old build and cannot become the new one. That is not a limitation to work
 *     around: it is why the user is told to start again with `--continue`.
 *
 * Two refusals, and both are the rule rather than a limitation:
 *
 *  - **a session this build may not open is not upgraded.** Upgrading means reading and
 *    writing the conversation, which is exactly what the pin forbids for another build.
 *    The way in is to start the version that owns it — which is also the flow the user is
 *    already in when this command is useful.
 *  - **a session already on this version is a no-op.** Nothing to move and nothing to pin;
 *    saying so is better than a second rename that would scramble the ordering for no gain.
 *
 * Like every command it returns a result object instead of printing, so the TUI and the
 * line CLI report it identically (`docs/interface/commands`).
 */

/** A refusal the user can act on: its own code, and a message naming the reason. */
function refuse(code, message) {
  return { ok: false, code, message };
}

/** `/upgrade` — move the open session to the newest installed version. */
export function upgradeCommand() {
  return {
    name: 'upgrade',
    description: 'move this session to the newest version (then restart with --continue)',
    run(ctx = {}) {
      const {
        arg = '',
        dir = undefined,
        sessions = null,
        // The newest version installed: what this session is moved *to*.
        version = latestVersion(),
        // The version this process is: what authorises the write.
        running = runningVersion(),
        now = new Date(),
      } = ctx;

      if (String(arg).trim() !== '') {
        return refuse('UNKNOWN_ARG', `Unknown argument "${arg}" for /upgrade. Use /upgrade on its own.`);
      }

      const id = sessions?.id;
      if (!id) {
        return refuse('NO_SESSION', 'This front end has no session, so there is nothing to upgrade.');
      }

      // The pin is read from the live recorder (which is what the loop passes) or from a
      // plain record, and normalised here: `sessionVersion()` takes a *record*, so a
      // recorder's own getter has to be read first.
      const raw = sessions?.monchoVersion;
      const pinned = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
      if (pinned !== null && pinned === version) {
        return refuse(
          'ALREADY_CURRENT',
          `This session is already on ${version}; there is nothing to upgrade.`,
        );
      }
      // A build may only write a conversation it owns, and an upgrade is a read *and* a
      // write. This is why the flow is ordered: start the version that owns the session,
      // open it, then move it towards the newest one.
      if (!canOpenSession(sessions, running)) {
        return refuse(
          'VERSION_LOCKED',
          `This session belongs to ${pinned ?? 'another version'}; open it with that version to upgrade it.`,
        );
      }

      // Move first: a crash after the rename leaves a session at its new id with the old
      // pin (still openable by the version that owns it), never the reverse.
      let moved;
      try {
        moved = moveSession(id, { dir, now });
      } catch (error) {
        return refuse(error.code || 'MOVE_FAILED', error.message);
      }

      const pin = upgradedPin(pinned, version, now);
      const id_ = moved.to;

      // The rename moved the folder; the pin is part of the *record*, so it is written
      // through the store rather than by hand. This is the step that makes the upgrade
      // real: without it the folder would have a new name and the old claim, and the next
      // save — at exit — would re-stamp the old version and undo the move.
      try {
        const record = loadSession(id_, { dir });
        // `id` must be the *new* one: `writeSession()` writes where the record says it
        // lives, so spreading the moved record without this writes a second copy back at
        // the old id — the exact duplication the rename existed to avoid.
        writeSession(serializeSession({ ...record, ...pin, id: id_ }), { dir });
      } catch (error) {
        return refuse(error.code || 'PIN_FAILED', `The session moved to ${id_} but its version could not be written: ${error.message}`);
      }
      return {
        ok: true,
        code: 'UPGRADED',
        id: id_,
        from: moved.from,
        monchoVersion: pin.monchoVersion,
        upgradedFrom: pin.upgradedFrom,
        upgradedAt: pin.upgradedAt,
        // The host continues the *moved* session so the exit save lands at the new id,
        // and ends the process: the container still runs the old build.
        close: true,
        message: [
          `Session ${id_} upgraded to ${pin.monchoVersion}${pin.upgradedFrom ? ` (was ${pin.upgradedFrom})` : ''}.`,
          'The CLI closes now: the container is still running the previous version.',
          'Restart to continue this conversation in the new one:',
          '  moncho-cli --continue',
        ].join('\n'),
      };
    },
  };
}