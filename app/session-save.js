import { createSessionRecorder } from './session-recorder.js';
import { createSessionAutosave } from './session-autosave.js';

/**
 * The conversation's record: the recorder, the save, and the mid-turn throttle.
 *
 * `main.js` only *wires* the session, and the record is the piece with the most moving
 * parts — a recorder that snapshots the window, a save that carries the stats, the usage
 * table and the append times, and an autosave throttle that writes mid-turn. Pulling the
 * three together here keeps the startup file about startup (`docs/runtime/startup-wiring`,
 * `docs/runtime/session-store`).
 *
 * Two readers are **live**, not snapshots, because both are read on *every* save:
 *
 *  - `stateOf()` — the intent mode and the `work:on` lock (`docs/interface/modes`);
 *  - `skinOf()` — the look the conversation is held in (`docs/interface/skins`).
 *
 * A save that fails is reported and returns `null` instead of throwing: a conversation
 * that cannot be written must not end the turn that produced it.
 *
 * @param {object} options
 * @param {object} options.manager the ConversationManager whose window is saved
 * @param {string} [options.model] the provider/model label
 * @param {Function} [options.stateOf] live reader of `{ mode, work }`
 * @param {Function} [options.skinOf] live reader of the active skin name
 * @param {object} [options.logger] the operational logger (`error` is the only level used)
 * @param {Function} [options.log] the front end's line sink
 * @returns {{sessions: object, saveSession: Function, autosave: object}}
 */
export function createSessionSave({
  manager,
  model = null,
  stateOf = null,
  skinOf = null,
  dir = undefined,
  logger = null,
  log = () => {},
} = {}) {
  const sessions = createSessionRecorder({ model, stateOf, skinOf, dir });

  // The throttle is late-bound: it writes *through* `saveSession`, which snapshots the
  // manager, so it can only exist once both are in place.
  let throttle = null;

  const saveSession = (reason) => {
    try {
      return sessions.save(manager.chunks, {
        reason,
        // The *uncompacted* history (app/context-window.js#ContextWindow.journal): the
        // window is what the model is sent and shrinks on a compaction, while the journal
        // keeps every chunk all the way back for conversation.json
        // (docs/runtime/conversation-log).
        journal: manager.contextWindow.journal,
        // The provenance of each journal chunk — the build that wrote it and what it
        // weighed (utils/chunk-meta.js, docs/runtime/chunk-provenance). Index-aligned with
        // the journal, so it travels with it and a later investigation can compare builds.
        journalMeta: manager.contextWindow.journalMeta,
        // The append time of each chunk, so a resumed transcript can show when each
        // block was written instead of the time the file was reopened
        // (utils/chunk-stamps.js, docs/interface/session-stamps).
        stamps: manager.contextWindow.stamps,
        stats: manager.contextWindow.stats(),
        // What each model consumed so far, so the session file is the accounting
        // record and `/usage` survives a restart.
        usage: manager.usageTable(),
      });
    } catch (error) {
      logger?.error?.('session', `could not save ${sessions.path}`, error);
      log(`\n[Session] Could not save ${sessions.path}: ${error.message}`);
      return null;
    }
  };

  // A stable handle, so the caller can pass it to the loop before the throttle exists:
  // every method is null-safe and reaches the real throttle once `start()` has run.
  const autosave = {
    touch: (reason) => throttle?.touch?.(reason),
    settle: () => throttle?.settle?.(),
    close: () => throttle?.close?.(),
    start: () => {
      throttle = createSessionAutosave({ save: () => saveSession('chunk') });
      return throttle;
    },
  };

  return { sessions, saveSession, autosave };
}
