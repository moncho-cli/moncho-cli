import { listSessions, loadSession, describeSession, sessionChunks, sessionUsage, sessionModeState, sessionTaskContent, sessionPlanContent } from '../utils/session-store.js';
import { readConversationLog } from '../utils/conversation-log-store.js';
import { formatUsageRows, normalizeModelUsage } from '../utils/usage-stats.js';
import { workCommand } from './work-command.js';
import { compactCommand } from './compact-command.js';

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
  registry.register(workCommand());
  registry.register(sessionsCommand());
  registry.register(usageCommand());
  registry.register(compactCommand());
  registry.register(helpCommand(registry));
  return registry;
}

/**
 * `/usage` — what each model consumed in this session.
 *
 * The status bar shows how full the context window is *right now*; this answers
 * the other question, "how many tokens did each model use", from the accounting
 * table the loop keeps (`utils/usage-stats.js`) and the session file stores.
 */
export function usageCommand() {
  return {
    name: 'usage',
    description: 'token usage per model in this session',
    run(ctx = {}) {
      const table = normalizeModelUsage(
        ctx.usage
        || (typeof ctx.manager?.usageTable === 'function' ? ctx.manager.usageTable() : {}),
      );
      return { ok: true, code: 'USAGE', lines: formatUsageRows(table), usage: table };
    },
  };
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
      // The uncompacted history, when the session kept one: `null` for a session written
      // before the log existed, in which case the live window is the best record there is
      // (docs/runtime/conversation-log). Loading it here is what makes a resumed session
      // keep the *whole* conversation in its log instead of restarting from the compacted
      // window.
      const journal = readConversationLog(session.id, { dir });
      if (!manager || typeof manager.contextWindow?.replace !== 'function') {
        return { ok: false, code: 'NO_WINDOW', message: 'This front end cannot load a session.' };
      }
      manager.contextWindow.replace(chunks, { journal });
      // The session file is the accounting record of the conversation, so its
      // per-model table becomes the live one: resuming continues the counts
      // instead of starting them again at zero.
      const usage = sessionUsage(session);
      if (typeof manager.usage?.replace === 'function') manager.usage.replace(usage);
      return {
        ok: true,
        code: 'RESUMED',
        id: session.id,
        chunks: chunks.length,
        usage,
        // The host reloads the conversation view from these and keeps saving into
        // this same file, so resuming continues the conversation instead of
        // starting a parallel one (docs/interface/session-replay).
        // A resumed `work:on` session opens locked; a file written before the mode
        // existed carries `null` and leaves the session in the state it opened with
        // (docs/interface/modes).
        resumed: { id: session.id, createdAt: session.createdAt, model: session.model, chunks },
        resumedMode: sessionModeState(session),
        taskContent: sessionTaskContent(session),
        planContent: sessionPlanContent(session),
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