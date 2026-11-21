import { truncateToWidth } from './cell-width.js';

/**
 * Slash-command completion: the **query** a half-typed `/…` stands for, and the
 * ranked rows a popup would show for it (task-backlog: "when user starts the
 * message with a slash, identify it and show a popup there right on top with the
 * matching commands and filter its as the user writes").
 *
 * Pure — a string in, a list of rows out, no widget and no registry — so the
 * filtering and the ranking are unit tested without a terminal. `app/slash-menu.js`
 * owns the cursor and the open/hide state, `app/slash-bar.js` paints the rows and
 * `app/prompt-keys.js` claims the keys.
 *
 * The command list is never copied: it is the registry's own `list()`
 * (`app/commands.js#createCommandRegistry`), so the popup can not drift from `/help`.
 */

/** How many rows the popup shows at once; the list past this scrolls. */
export const SLASH_MAX_ROWS = 6;

/**
 * The query a half-typed slash command stands for, or null when the box is not
 * completing one.
 *
 * A leading `/`, no whitespace, and an optional row of letters, digits, `-` or `_`
 * — the very character class `parseCommand()` accepts (`app/commands.js`), so the
 * popup can never offer a name the parser would not read. Anything else is a prompt:
 * a bare `/` on its own *is* a query (it lists every command), while `/help me` and
 * `ask /help` are not, because the first argument ends the command name.
 *
 * @param {string} text the input box's value, verbatim
 * @returns {{ query: string } | null} the text after the slash ('' for a bare `/`),
 *   or null when the box is not completing a command name.
 */
export function slashQuery(text) {
  const value = String(text ?? '');
  const match = value.match(/^\/([A-Za-z][\w-]*)?$/);
  if (!match) return null;
  return { query: match[1] || '' };
}

/**
 * How a command answers one query, as a rank. Lower is better, and null means
 * "not a match".
 *
 * Two tiers, and both are about the **name**, because the popup completes a command
 * name and is not a search engine: the **prefix** (`/co` → `compact`) and then a
 * **subsequence** anywhere (`/ses` → `sessions`, `/wrk` → `work`), which is what
 * makes a skipped letter still find its command. A command's **aliases** count as
 * its name, because `/resume` really is an invocation of `sessions`.
 *
 * The **description is deliberately not searched.** Matching it looked helpful and
 * was not: every description here is prose, so `/co` matched `help` and `sessions`
 * through the word "commands" and "conversations" and the careful ranking below was
 * buried under noise. A typed word that names no command leaves the popup closed,
 * and the box keeps taking a prompt — which is the honest answer to a query the
 * commands do not answer. Ties are broken in `rankCommands()`.
 */
function matchRank(command, query) {
  if (!query) return 0;
  const needle = query.toLowerCase();
  const names = [command.name, ...(command.aliases || [])].map((name) => String(name || '').toLowerCase());

  if (names.some((name) => name.startsWith(needle))) return 0;

  // A subsequence: every typed character appears, in order, somewhere in a name.
  if (names.some((name) => isSubsequence(needle, name))) return 1;

  return null;
}

/** True when every character of `needle` appears in `hay` in order. */
function isSubsequence(needle, hay) {
  let at = 0;
  for (const char of needle) {
    at = hay.indexOf(char, at);
    if (at < 0) return false;
    at += 1;
  }
  return true;
}

/**
 * The commands that answer a query, best first.
 *
 * Ranking is `matchRank()` and then the name, so the answer is deterministic: a
 * prefix match always beats a subsequence, which always beats a description match,
 * and inside a tier the alphabetical order the registry already keeps decides.
 * An empty query returns every command in that order, which is what makes a bare
 * `/` a browsable list rather than an empty popup.
 *
 * @param {object[]} commands `{ name, description, aliases }`, from the registry
 * @param {string} query the text after the slash, or '' for all of them
 * @returns {object[]} a new array; the registry's objects are never mutated
 */
export function rankCommands(commands, query) {
  const list = Array.isArray(commands) ? commands : [];
  const needle = String(query ?? '');
  const ranked = [];

  for (const command of list) {
    if (!command || typeof command.name !== 'string' || !command.name) continue;
    const rank = matchRank(command, needle);
    if (rank === null) continue;
    ranked.push({ command, rank });
  }

  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.command.name.localeCompare(b.command.name);
  });

  return ranked.map((entry) => entry.command);
}

/**
 * One popup row, fitted to `columns` display cells: the marker, the name and then
 * as much of the description as fits.
 *
 * Cells rather than characters (`app/cell-width.js#truncateToWidth`), because a row
 * that wraps inside the region is the one that gets clipped — the bug the queue
 * preview had (see `docs/interface/message-queue`). The name is never truncated: it
 * is the thing the popup exists to show, and it is short by construction.
 *
 * @param {object} command the registry entry
 * @param {object} [options]
 * @param {boolean} [options.selected] whether this row carries the cursor
 * @param {number} [options.columns] the interior width of the bar, in cells
 * @returns {string} the row's text, without any colour tag
 */
export function formatSlashRow(command, { selected = false, columns = 0 } = {}) {
  const name = String(command?.name || '');
  const marker = selected ? '>' : ' ';
  const width = Math.max(0, Math.trunc(Number(columns)) || 0);
  // A command name is ASCII by construction (`parseCommand()`'s `[A-Za-z][\w-]*`), so
  // its length in code units is its width in cells and the room below can be one sum.
  const head = `${marker} /${name}`;

  const description = String(command?.description || '');
  if (!description) return width > 0 ? truncateToWidth(head, width) : head;

  // The room left for the description: the bar's width, less the head and the two
  // spaces that separate the name from it. With no width known (no widget yet) the
  // description is left whole rather than cut to an arbitrary guess.
  const room = width > 0 ? width - head.length - 2 : 0;
  if (width > 0 && room <= 1) return truncateToWidth(head, width);
  const shown = width > 0 ? truncateToWidth(description, room) : description;
  return `${head}  ${shown}`;
}

/**
 * The rows the popup shows, selected row included, over a list ranked by
 * `rankCommands()`.
 *
 * The rule is the picker's (`app/picker.js#createPicker.window`): the cursor is kept
 * inside the window, so the list scrolls instead of overflowing, and the window is
 * centred on it where there is room on both sides.
 *
 * @param {object[]} commands the ranked list
 * @param {object} [options]
 * @param {number} [options.index] the cursor, in the ranked list
 * @param {number} [options.columns] the interior width of the bar, in cells
 * @param {number} [options.maxRows] how many rows fit at once
 * @returns {Array<{ command: object, index: number, selected: boolean, text: string }>}
 */
export function slashRows(commands, { index = 0, columns = 0, maxRows = SLASH_MAX_ROWS } = {}) {
  const list = Array.isArray(commands) ? commands : [];
  if (list.length === 0) return [];

  const size = Math.max(1, Math.trunc(Number(maxRows)) || SLASH_MAX_ROWS);
  const cursor = Math.max(0, Math.min(list.length - 1, Math.trunc(Number(index)) || 0));
  const start = Math.max(0, Math.min(cursor - Math.floor(size / 2), Math.max(0, list.length - size)));

  return list.slice(start, start + size).map((command, offset) => {
    const at = start + offset;
    const selected = at === cursor;
    return { command, index: at, selected, text: formatSlashRow(command, { selected, columns }) };
  });
}
