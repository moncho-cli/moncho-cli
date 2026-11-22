import { fgTag } from './paint-tags.js';
import { CONVERSATION_COLORS, THEME_TOKENS } from './theme-palette.js';

/**
 * The **row painters** (`docs/interface/conversation-colors`, `docs/interface/skins`): one
 * function per kind of row whose colour and bold are decided together — the reason for a
 * call, a tracking milestone, a refusal, a timestamp.
 *
 * Split out of `app/theme-palette.js`, which owns the *values*; these functions own the
 * *presentation* of one row and would otherwise grow that module past its line budget. Each
 * reads the live palette and tokens at call time, never a snapshot, so a skin repaints the
 * row it paints — the whole point of the live objects.
 *
 * Pure and terminal-free: a caller (or a test) gets a blessed tag back as a string, never a
 * screen.
 */

/**
 * One intent, painted the way the backlog asks for it: a bright blue and bold. The colour
 * makes it findable inside the tool row that carries it, the bold makes it stand out in a
 * wall of output. Reads the *live* colour and bold token.
 */
export function colorizeIntent(text) {
  const body = String(text ?? '');
  const color = CONVERSATION_COLORS.intent;
  if (THEME_TOKENS.boldIntent === false) return fgTag(color, body);
  return fgTag(color, `{bold}${body}{/bold}`);
}

/**
 * One tracking update, painted the way a milestone should read: its own bright colour plus
 * bold, so a `[Tracking]` row can never be mistaken for a tool result or a context notice
 * (magenta). Reads the live colour and bold token.
 */
export function colorizeTracking(text) {
  const body = String(text ?? '');
  const color = CONVERSATION_COLORS.tracking;
  if (THEME_TOKENS.boldTracking === false) return fgTag(color, body);
  return fgTag(color, `{bold}${body}{/bold}`);
}

/**
 * One refusal row, painted the way the news it carries should read: the bright red no other
 * row uses, plus bold, so a refused call is findable in a wall of tool output and can never
 * be mistaken for a plain error (red, not bold). Reads the live colour.
 */
export function colorizeRefusal(text) {
  const body = String(text ?? '');
  const color = CONVERSATION_COLORS.refusal;
  return fgTag(color, `{bold}${body}{/bold}`);
}

/**
 * One timestamp, painted as chrome: the live `stamp` colour, and never bold. It is its own
 * palette key rather than `notice` so a timestamp stays legible on a default terminal — the
 * default `stamp` is the terminal's own foreground, not the near-invisible ANSI grey — and a
 * skin can still move it without also moving every `[Info]` notice.
 */
export function colorizeStamp(stamp) {
  const body = String(stamp ?? '');
  if (!body) return '';
  const color = CONVERSATION_COLORS.stamp;
  return `${fgTag(color, body)} `;
}
