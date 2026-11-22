/**
 * One colour per *family* of tool operation (task-backlog: "use different colors for
 * read, write, and bash type of operations so they are easy trackable in the
 * conversation at a glance").
 *
 * `app/theme.js` answers "what kind of row is this" — the user's echo, a tool call, a
 * context notice — and one colour per kind is not enough for the busiest kind of them
 * all. A transcript holds a dozen tool rows in a row, and the reader wants to see at a
 * glance *what the agent is doing*: looking at something, changing something, or
 * running a command. So the tool kind is subdivided here:
 *
 * | family  | tools                                        | colour       | reads as             |
 * | ------- | -------------------------------------------- | ------------ | -------------------- |
 * | `read`  | `read_file`, `hint_file`, `blob`, `grep`, `read_capture`, `web_fetch` | bright cyan | looking, no change |
 * | `write` | `write_file`, `edit_file`, `delete_file`, `write_plan_md`, `edit_plan_md` | green | the tree changed |
 * | `bash`  | `run_bash`, `run_npm`                        | yellow       | a process ran        |
 * | `other` | `update_task`, `compact_context`, anything unknown | yellow | neither of the above |
 *
 * Three decisions worth naming:
 *
 *  - **`read` is bright cyan, not plain cyan.** Plain cyan is already the user's own
 *    echo (`CONVERSATION_COLORS.user`), and "what I asked" must not read as "what the
 *    agent looked at"; the bright variant is also the colour `app/tui-render.js`
 *    gives the `<file relative_path="…">` / `<grep …>` delimiter a read returns, so a
 *    read and its own output read as one block instead of two unrelated colours.
 *  - **`write` is plain green**, deliberately not the bright green of a `[Tracking]`
 *    row: the two sit next to each other, and a milestone (`docs/interface/tracking-notice`)
 *    must never be mistaken for an edit.
 *  - **`other` keeps the historical yellow**, so a tool nobody classified looks exactly
 *    like it always did. `bash` shares that yellow on purpose: it is the family the
 *    colour came from, and a shell is the tool a reader least needs an extra cue for.
 *
 * Pure and terminal-free: names in, blessed tag colour names out, so the mapping is
 * unit tested without a terminal.
 */

/**
 * Which family a tool belongs to. A name that is not listed is `other`, never a
 * guess: an unclassified tool must not be painted as a write.
 */
export const TOOL_FAMILIES = Object.freeze({
  read_file: 'read',
  hint_file: 'read',
  blob: 'read',
  grep: 'read',
  read_capture: 'read',
  web_fetch: 'read',
  write_file: 'write',
  edit_file: 'write',
  delete_file: 'write',
  write_plan_md: 'write',
  edit_plan_md: 'write',
  run_bash: 'bash',
  run_npm: 'bash',
});

/**
 * One blessed colour per family. `other` is the fallback for a row that names no tool
 * this table knows: `app/theme.js` passes the **live** kind colour (`CONVERSATION_COLORS.tool`)
 * in, so a skin can move it (`docs/interface/skins`) while the three named families keep
 * their own fixed colours.
 */
export const TOOL_COLORS = Object.freeze({
  read: 'bright-cyan',
  write: 'green',
  bash: 'yellow',
  other: 'yellow',
});/** The family a tool name belongs to (`'other'` for anything unlisted). */
export function toolFamily(name) {
  const key = String(name ?? '').trim();
  return TOOL_FAMILIES[key] || 'other';
}

/**
 * The colour for a tool name (or a family name, which passes straight through).
 *
 * A family's colour is now a **palette key** (`toolRead`/`toolWrite`/`toolBash`), not a
 * constant in this module: the three colours used to be frozen here, so a skin could move
 * every other row while a tool row stayed as shipped — exactly the "it saved but nothing
 * changed" report. `livePalette` is the palette in force, passed in rather than imported so
 * this module stays terminal-free and pure.
 *
 * `TOOL_COLORS` remains the shipped default, which is what a caller with no palette gets.
 */
export function toolColorFor(name, { palette = TOOL_COLORS, fallback = null } = {}) {
  const key = String(name ?? '').trim();
  const family = Object.prototype.hasOwnProperty.call(TOOL_COLORS, key) ? key : toolFamily(key);
  // The palette names each family `toolRead`/`toolWrite`/`toolBash`; `other` is the kind's
  // own colour, which the caller passes as `fallback`.
  if (family === 'other') return fallback ?? palette.tool ?? TOOL_COLORS.other;
  const slot = `tool${family[0].toUpperCase()}${family.slice(1)}`;
  return palette[slot] ?? TOOL_COLORS[family];
}

/** The `-> Calling <name>` line the conversation loop prints. */
const CALLING_RE = /^\s*->\s*Calling\s+([A-Za-z0-9_.-]+)/;

/** The `[<name> Output]` header of a tool result (a block header carries it too). */
const OUTPUT_RE = /\[([A-Za-z0-9_.-]+)\s+Output\]/;

/**
 * The tool a rendered row names, or `null` when the row names none.
 *
 * The two shapes the transcript uses are the ones `app/tool-call-format.js` produces —
 * a `-> Calling <name>(…)` line and a `[<name> Output]` header, which a collapsed block
 * carries in the middle of its header row (`▸   [read_file Output] — …`). Anything else
 * answers `null`, so the caller falls back to the colour of the row's kind instead of
 * guessing a family.
 */
export function toolNameOf(line) {
  const text = String(line ?? '');
  const calling = text.match(CALLING_RE);
  if (calling) return calling[1];
  const output = text.match(OUTPUT_RE);
  if (output) return output[1];
  return null;
}
