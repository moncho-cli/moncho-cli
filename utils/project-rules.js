import fs from 'fs';

import { hostFenceEnabled } from '../config/constants.js';
import { resolveProjectPath } from './path-safety.js';

/**
 * The project's own rules, handed to the model on every request (task-backlog item 50).
 *
 * The agent prompt (`config/prompt.md`) is *Moncho's* rules: how it works, everywhere.
 * A repository also has rules of its own — how its code is written, what its tests look
 * like, which files are generated — and in the convention this project already uses they
 * live in a single `AGENTS.md` at the project root. The model never saw that file: the
 * whole feature was absent, so a session in a foreign repository was governed only by the
 * agent's own habits.
 *
 * It rides the **request prelude** (`app/context-window.js#ContextWindow.request`) beside
 * the session block, for the same reasons that block does:
 *
 *  - it is *project data*, not conversation, so it never becomes a window chunk, never
 *    reaches `context.json`, and cannot be evicted by a compaction;
 *  - it is read **again on every call**, so a rule the user (or the model) edits mid-session
 *    takes effect on the next request instead of on the next resume. The read is keyed on
 *    the file's size and mtime, so an unchanged file costs one `stat` and no parse.
 *
 * Three bounds keep it from becoming a liability:
 *
 *  - **the user flow only.** `hostFenceEnabled()` already distinguishes a user's project
 *    from the maintainer's own checkout; for the maintainer, `prompt.md` *is* the project's
 *    rules, and quoting the repository back to itself would only take context.
 *  - **a hard size bound.** The block never exceeds `MAX_RULES_CHARS`; a longer file is cut
 *    and the block says so, with the path to read for the rest. Silent truncation would be
 *    a rule the model believes it was given and never was.
 *  - **absence is silence.** No file means no block, so a project without rules sends
 *    exactly what it sent before.
 */

/** The file this convention names, at the project root. */
export const RULES_FILE = 'AGENTS.md';

/** How much of the file one request may carry. */
export const MAX_RULES_CHARS = 12000;

/** The marker the block starts with, so a reader can recognise it in a request. */
export const RULES_MARKER = '[project]';

// One entry: the last file read, keyed by the facts that would make it stale. Keeps a
// per-call read at one `stat` while still honouring an edit immediately.
let cached = null;

/**
 * Render the block from the facts, so the wording is unit-testable without a filesystem.
 *
 * @param {{text: string, truncated?: boolean, maxChars?: number, file?: string}} rules
 * @returns {string} the message content, or `''` when there is nothing to say
 */
export function formatRulesBlock({ text, truncated = false, maxChars = MAX_RULES_CHARS, file = RULES_FILE } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return '';
  const budget = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : MAX_RULES_CHARS;
  return [
    `${RULES_MARKER} ${file} is this project's own rule book, and it is in force for every`
      + ' task in this conversation. It sits on top of your own instructions: where the two'
      + ' disagree about *this* repository — its layout, its style, its commands, its'
      + ' generated files — the project wins. The conversation may follow the user\'s'
      + ' language; the code, the artefacts and the tasks stay in the project\'s own.',
    'Read as it is written for this project:',
    '',
    body,
    ...(truncated
      ? ['', `(...) this file is longer than the ${budget} characters a request may carry;`
        + ` the rest is not included — read ${file} for the remainder.`]
      : []),
  ].join('\n');
}

/**
 * The project's rules as one system message, or `null` when there is nothing to hand over.
 *
 * A missing, empty or unreadable file is `null`: a project without rules is not a
 * conversation that should be told about an empty one. The maintainer's own checkout is
 * `null` too — see the note at the top of this module.
 *
 * @param {{root?: string, enabled?: boolean}} [options] overrides for a test, never for the
 *   shipped path: the default reads the live switch and the live project root
 * @returns {{role: 'system', content: string}|null}
 */
export function projectRulesMessage({ root = null, enabled = null } = {}) {
  const on = enabled === null ? hostFenceEnabled() : enabled === true;
  if (!on) return null;

  let absolute;
  try {
    absolute = root ? `${root.replace(/\/+$/, '')}/${RULES_FILE}` : resolveProjectPath(RULES_FILE);
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size === 0) return null;

    const key = `${absolute}:${stat.size}:${stat.mtimeMs}`;
    if (!cached || cached.key !== key) {
      cached = { key, text: fs.readFileSync(absolute, 'utf-8') };
    }
    const full = cached.text;
    const truncated = full.length > MAX_RULES_CHARS;
    const content = formatRulesBlock({
      text: truncated ? full.slice(0, MAX_RULES_CHARS) : full,
      truncated,
      file: RULES_FILE,
    });
    return content ? { role: 'system', content } : null;
  } catch {
    // Missing or unreadable is not an error for the caller: the request goes out as it
    // did before this module existed.
    return null;
  }
}

/** Drop the cached read. For a test that rewrites the file within one filesystem tick. */
export function forgetRulesCache() {
  cached = null;
}