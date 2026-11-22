import {
  listSessions, loadSession, describeSession, sessionTaskContent, sessionPlanContent,
} from '../utils/session-store.js';
import { writeTaskContent, writePlanContent, trackingPaths } from '../utils/tracking-store.js';
import { notifyTrackingUpdate } from '../utils/host.js';
import { canonicalizeTrackingFile, validateTrackingFile } from '../utils/tracking-format.js';

/**
 * `/ref` — port a previous session's tracking pair into this one.
 *
 * The practical case the backlog names: *"hey, I was working there, let's resume here"*.
 * A fresh session starts with an empty checklist; `/sessions` would drag the whole
 * conversation along with it. `/ref` takes only the two files — the checklist and the
 * plan — so the work carries over while the context stays clean.
 *
 * Four decisions:
 *
 *  - **it ports the pair, not the conversation.** `task.md` and `implementation_plan.md`
 *    are the only things written; no chunk, no usage count, no mode is touched. The
 *    current session stays exactly as it was apart from its two files.
 *  - **it never overwrites silently.** The current pair always exists (a session is
 *    seeded with one), so a plain port would destroy whatever the user had written. A
 *    bare `/ref` therefore *asks* first, and `--force` is the explicit overwrite. A
 *    cancelled ask changes nothing.
 *  - **it writes through the tracking store.** `writeTaskContent()` /
 *    `writePlanContent()` are the same writers `update_task` uses, so the file and the
 *    session record stay in step and the bytes are canonical — the ported pair opens in
 *    the same shape the tracking tools expect.
 *  - **it ports what the record holds.** The source pair is read from the session record
 *    (`sessionTaskContent()` / `sessionPlanContent()`), because the source folder's files
 *    may have been edited by hand and the record is what a resume would carry. A source
 *    with no pair is refused rather than porting nothing.
 *
 * Nothing is ported when the source has no content: `EMPTY_SOURCE` names the reason so a
 * user who picked a session that never used the checklist is told why.
 */

/** The flag that overwrites without asking. */
export const FORCE_FLAG = '--force';

/**
 * Parse the argument: an optional session id and the overwrite flag, in any order.
 *
 * @param {string} arg the raw argument
 * @returns {{id: string, force: boolean, unknown: string[]}}
 */
export function parseRefArg(arg = '') {
  const words = String(arg ?? '').trim().split(/\s+/).filter(Boolean);
  let id = '';
  let force = false;
  const unknown = [];
  for (const word of words) {
    if (word === FORCE_FLAG) { force = true; continue; }
    if (word.startsWith('-')) { unknown.push(word); continue; }
    if (!id) { id = word; continue; }
    unknown.push(word);
  }
  return { id, force, unknown };
}

/**
 * Find the session to port from.
 *
 * An id is matched exactly first, then by prefix — the same forgiving rule `/sessions`
 * uses, so a user who typed the first half of a timestamp lands on the right session.
 *
 * @returns {{session: object|null, error: string|null}}
 */
export function findSource(id, { dir = undefined } = {}) {
  const summaries = listSessions({ dir });
  if (summaries.length === 0) return { session: null, error: 'NO_SESSIONS' };
  if (!id) return { session: null, error: null };
  const exact = summaries.find((entry) => entry.id === id);
  const byPrefix = exact || summaries.find((entry) => entry.id.startsWith(id));
  if (!byPrefix) return { session: null, error: 'UNKNOWN_SESSION' };
  if (byPrefix.error) return { session: null, error: 'UNREADABLE' };
  return { session: byPrefix, error: null };
}

/**
 * The pair a session record carries, canonicalised and validated.
 *
 * @param {object} session the loaded source session
 * @returns {{task: string|null, plan: string|null}}
 */
export function sourcePair(session) {
  const task = sessionTaskContent(session);
  const plan = sessionPlanContent(session);
  return {
    task: typeof task === 'string' && task.trim() !== '' ? canonicalizeTrackingFile('task', task) : null,
    plan: typeof plan === 'string' && plan.trim() !== '' ? canonicalizeTrackingFile('plan', plan) : null,
  };
}

/** `/ref [<id>] [--force]` — port a previous session's tracking pair into this one. */
export function refCommand() {
  return {
    name: 'ref',
    description: 'port a previous session\'s task.md and implementation_plan.md into this session (/ref <id> [--force])',
    aliases: ['refer'],
    async run(ctx = {}) {
      const dir = ctx.dir;
      const parsed = parseRefArg(ctx.arg);
      if (parsed.unknown.length > 0) {
        return {
          ok: false,
          code: 'UNKNOWN_ARG',
          message: `Unknown argument "${parsed.unknown[0]}". Use /ref [<id>] [--force].`,
        };
      }

      const found = findSource(parsed.id, { dir });
      if (found.error === 'NO_SESSIONS') {
        return { ok: true, code: 'NO_SESSIONS', message: 'No stored sessions to port from yet.' };
      }
      if (found.error === 'UNKNOWN_SESSION') {
        return { ok: false, code: 'UNKNOWN_SESSION', message: `No stored session matches ${parsed.id}.` };
      }
      if (found.error === 'UNREADABLE') {
        return { ok: false, code: 'UNREADABLE', message: `Session ${parsed.id} cannot be read.` };
      }

      // No id: the user picks one. A front end without a chooser is refused rather than
      // guessing — porting the wrong checklist over the current one is not a small mistake.
      let summary = found.session;
      if (!summary) {
        const summaries = listSessions({ dir });
        if (typeof ctx.choose !== 'function') {
          return {
            ok: false,
            code: 'NEEDS_ID',
            message: 'Name the session to port from: /ref <id>, or use a front end with a picker.',
            sessions: summaries,
          };
        }
        const labels = summaries.map((entry) => describeSession(entry));
        const index = await ctx.choose(labels, { title: 'Port from session' });
        if (index == null) return { ok: true, code: 'CANCELLED' };
        summary = summaries[Number(index)];
        if (!summary || summary.error) {
          return { ok: false, code: 'UNREADABLE', message: `Session ${summary?.id} cannot be read.` };
        }
      }

      let session;
      try {
        session = loadSession(summary.id, { dir });
      } catch (error) {
        return { ok: false, code: 'UNREADABLE', message: `Session ${summary.id} cannot be read (${error.code || error.message}).` };
      }

      const pair = sourcePair(session);
      const kinds = ['task', 'plan'].filter((kind) => pair[kind] !== null);
      if (kinds.length === 0) {
        return {
          ok: false,
          code: 'EMPTY_SOURCE',
          message: `Session ${summary.id} has no task.md or implementation_plan.md to port.`,
        };
      }

      // A port replaces the current pair, so it asks first unless the user said --force.
      const paths = trackingPaths({ dir });
      if (!paths.folder) {
        return { ok: false, code: 'NO_SESSION', message: 'This front end has no session to port into.' };
      }
      if (!parsed.force && typeof ctx.confirm === 'function') {
        const names = kinds.map((kind) => (kind === 'task' ? 'task.md' : 'implementation_plan.md'));
        const approved = await ctx.confirm(
          `Replace this session's ${names.join(' and ')} with the pair from ${summary.id}?`,
          { title: 'Port tracking files' },
        );
        if (!approved) return { ok: true, code: 'CANCELLED' };
      }

      const written = [];
      for (const kind of kinds) {
        const content = pair[kind];
        const check = validateTrackingFile(content, { kind });
        if (!check.ok) {
          return {
            ok: false,
            code: 'INVALID_SOURCE',
            message: `The ${kind} pair of ${summary.id} is not a valid tracking document: ${check.problems.join('; ')}`,
          };
        }
        if (kind === 'task') writeTaskContent(content);
        else writePlanContent(content);
        written.push(kind === 'task' ? 'task.md' : 'implementation_plan.md');
      }

      // The port is a tracking write like any other, so it is announced like one: the
      // `[Tracking]` rows and the content blocks come from the same sink the tools use
      // (`app/tracking-block.js`), which is what shows the user what landed.
      const update = {
        taskWritten: written.includes('task.md'),
        planWritten: written.includes('implementation_plan.md'),
      };
      notifyTrackingUpdate(update);

      return {
        ok: true,
        code: 'PORTED',
        from: summary.id,
        documents: written,
        ...update,
        message: `Ported ${written.join(' and ')} from ${summary.id}.`,
      };
    },
  };
}
