import { listSessions, loadSession, describeSession, sessionChunks } from '../utils/session-store.js';

/**
 * Slash commands: the iterable registry behind `/sessions` (task.md item 4).
 *
 * A command is a small object — `{ name, description, aliases, run(ctx) }` — kept
 * in a `Map`, so adding a command later is one `register()` call and nothing else
 * in the host loop changes. `parseCommand()` recognises `/<name> <rest>` input and
 * leaves anything else alone, so ordinary prompts (and a bare `/`) fall through to
 * the model untouched.
 *
 * `run(ctx)` receives a context object supplied by the host: `{ arg, choose,
 * manager, dir }`. Commands return a plain object describing what happened
 * (`{ ok, code, lines?, message?, ... }`), which the host formats and prints —
 * commands never print directly, so both front ends behave the same way.
 */

export function createCommandRegistry() {
  const commands = new Map();

  const registry = {
    register(command) {
      if (!command || typeof command.name !== 'string' || !command.name) {
        throw new TypeError('a command needs a name');
      }
      if (typeof command.run !== 'function') {
        throw new TypeError(`command /${command.name} needs a run() function`);
      }
      const names = [command.name, ...(command.aliases || [])];
      for (const name of names) commands.set(name.toLowerCase(), command);
      return command;
    },
    get(name) {
      return commands.get(String(name ?? '').toLowerCase()) || null;
    },
    has(name) {
      return registry.get(name) !== null;
    },
    /** Every registered command once, sorted by name (for /help). */
    list() {
      const unique = new Set(commands.values());
      return [...unique].sort((a, b) => a.name.localeCompare(b.name));
    },
    /** The `/help` text, derived from the registry itself. */
    helpLines() {
      return registry.list().map((command) => `/${command.name} — ${command.description}`);
    },
  };

  return registry;
}

/**
 * Parse `/name rest of the line`. Returns null for anything that is not a command
 * invocation (so the host keeps it as a prompt).
 */
export function parseCommand(input) {
  const text = String(input ?? '');
  const match = text.match(/^\s*\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: match[1].toLowerCase(), arg: (match[2] || '').trim() };
}

/** The built-in commands, registered into a fresh registry. */
export function createDefaultCommands() {
  const registry = createCommandRegistry();
  registry.register(sessionsCommand());
  registry.register(helpCommand(registry));
  return registry;
}

/** `/help` — list what is available, from the registry itself. */
export function helpCommand(registry) {
  return {
    name: 'help',
    description: 'list the available commands',
    run: () => ({ ok: true, code: 'HELP', lines: registry.helpLines() }),
  };
}

/** `/sessions` — list the stored conversations and pick one up again. */
export function sessionsCommand() {
  return {
    name: 'sessions',
    description: 'list stored conversations and continue one',
    aliases: ['resume'],
    async run(ctx = {}) {
      const { arg = '', dir = undefined, choose, manager } = ctx;
      const summaries = listSessions({ dir });

      if (summaries.length === 0) {
        return { ok: true, code: 'NO_SESSIONS', message: 'No stored sessions yet.' };
      }

      // `/sessions <id>` resumes directly; a bare `/sessions` opens the picker.
      let picked = null;
      if (arg) {
        const wanted = summaries.find((entry) => entry.id === arg || entry.id.startsWith(arg));
        if (!wanted) {
          return { ok: false, code: 'UNKNOWN_SESSION', message: `No stored session matches ${arg}.`, sessions: summaries };
        }
        picked = wanted;
      } else if (typeof choose === 'function') {
        const labels = summaries.map((entry) => describeSession(entry));
        const index = await choose(labels, { title: 'Sessions' });
        if (index == null) return { ok: true, code: 'CANCELLED' };
        picked = summaries[Number(index)];
      } else {
        const lines = summaries.map((entry) => describeSession(entry));
        return { ok: true, code: 'LISTED', lines, sessions: summaries };
      }

      if (!picked || picked.error) {
        return { ok: false, code: 'UNREADABLE', message: `Session ${picked?.id} cannot be read (${picked?.error}).` };
      }

      const session = loadSession(picked.id, { dir });
      const chunks = sessionChunks(session);
      if (!manager || typeof manager.contextWindow?.replace !== 'function') {
        return { ok: false, code: 'NO_WINDOW', message: 'This front end cannot load a session.' };
      }
      manager.contextWindow.replace(chunks);
      return {
        ok: true,
        code: 'RESUMED',
        id: session.id,
        chunks: chunks.length,
        message: `Resumed ${session.id} (${chunks.length} chunk(s)).`,
      };
    },
  };
}

/**
 * Run a parsed command against the registry.
 * @returns {Promise<object|null>} the command result, or null when unknown.
 */
export async function runCommand(registry, name, ctx = {}) {
  const command = registry.get(name);
  if (!command) return null;
  return command.run(ctx);
}
