import { parseCommand } from './commands.js';

/**
 * A slash command submitted **while a turn is in flight**.
 *
 * The pending-message queue exists for prompts: a turn can take minutes, and a
 * message typed during one has to survive until the next turn
 * (`docs/interface/message-queue`). A **command** is not a message for the model —
 * `/task`, `/help` and `/usage` answer locally and never reach the provider — so
 * putting one in the queue is wrong twice over: the user waits a whole turn for an
 * answer that is already available, and the queue row claims a prompt that will
 * never be sent. The backlog says it plainly:
 *
 * > slash commands like /task (there are probably others) should not be queued, as
 * > those are not messages for the model, they need to be able to be ran in
 * > parallel while the model thinks
 *
 * The verdict is **deterministic**, and it is decided by the command itself rather
 * than by a list kept here: a command that only reads state declares
 * `busy: 'parallel'` on its own object (`/help`, `/usage`, `/task`), and everything
 * else is deferred. The default is the safe half deliberately — a new command that
 * forgets to declare anything is refused mid-turn instead of quietly mutating the
 * window the running turn is still writing to. Those mutations are real: `/new`
 * empties the context window, `/sessions` replaces it, `/compact` rewrites it and
 * `/ref` overwrites the tracking pair, so running one underneath a live turn would
 * corrupt the very state the turn is appending to.
 *
 * Pure: no widget, no host, no promise — one function that answers what an input
 * means while a turn runs, so every rule below is unit tested without a terminal.
 */

/** True when this input is a command whose only effect is to read state. */
export function isParallelCommand(command) {
  return Boolean(command) && command.busy === 'parallel';
}

/**
 * What a submission means while a turn is in flight.
 *
 * @param {string} input the bytes the user submitted
 * @param {{registry?: object}} [options] the command registry (`get(name)`)
 * @returns {null | {kind: 'run', name: string, command: object}
 *   | {kind: 'refuse', name: string, message: string}}
 *   `null` for anything that is not a command — a prompt, which the caller queues as
 *   it always did.
 */
export function busyVerdict(input, { registry = null } = {}) {
  const parsed = parseCommand(input);
  if (!parsed) return null;

  const command = registry && typeof registry.get === 'function' ? registry.get(parsed.name) : null;
  if (!command) {
    // The same wording the host loop uses between turns, so a typo is answered the
    // same way whenever it is typed — and never waits for a turn to be told.
    return { kind: 'refuse', name: parsed.name, message: `Unknown command /${parsed.name}. Try /help.` };
  }
  if (isParallelCommand(command)) return { kind: 'run', name: parsed.name, command };

  return {
    kind: 'refuse',
    name: parsed.name,
    message: `/${command.name} cannot run while a turn is in progress: it changes the conversation. Try it when the turn ends.`,
  };
}

/**
 * The hook a front end installs on its input box: take a submission that arrives
 * mid-turn, or hand it back so the queue can hold it.
 *
 * The decision is **synchronous** and the work is not: it is called from a key
 * handler that must return at once, so a command that opens a modal (`/task`) or
 * awaits the provider is started and left to finish. A failure inside the command is
 * reported through `notify`, never thrown into the keystroke, because a broken
 * command must not take the input box down with the turn still running.
 *
 * @param {object} options
 * @param {object} [options.registry] the command registry (`app/commands.js`)
 * @param {Function} options.run `(input) => Promise<unknown>` — runs one command
 *   through the host's own path (`app/session-loop.js#handleCommand`), so a command
 *   typed mid-turn behaves exactly like one typed between turns
 * @param {Function} [options.notify] `(kind, text)` — the transient surface
 *   (`app/notice-sink.js`); the line CLI's plain line is the same hook without a bar
 * @returns {(input: string) => boolean} true when the input was consumed here
 */
export function createBusyCommandRunner({ registry = null, run = null, notify = () => {} } = {}) {
  return (input) => {
    const verdict = busyVerdict(input, { registry });
    // Not a command: a prompt stays the queue's business (docs/interface/message-queue).
    if (!verdict) return false;

    if (verdict.kind === 'refuse') {
      notify('info', verdict.message);
      return true;
    }

    if (typeof run !== 'function') {
      notify('warn', `/${verdict.name} cannot run in this front end while a turn is in progress.`);
      return true;
    }

    // Started, never awaited: a keystroke cannot wait for a modal or a provider call.
    Promise.resolve()
      .then(() => run(input))
      .catch((error) => {
        notify('error', `/${verdict.name} failed: ${error?.message ?? String(error)}`);
      });
    return true;
  };
}