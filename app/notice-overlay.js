import { CONVERSATION_COLORS } from './theme.js';
import { sanitize } from './tui-render.js';
import { cutCodePoints } from './cell-width.js';
import { fgTag } from './paint-tags.js';

/**
 * Transient notices and the overlay that shows them (task-backlog: "clean up failed
 * attempts, i got a 502 error then it worked but the error text was still there.
 * this info should also be displayed in some kind of overlay near the top of the
 * screen and auto hide after some minutes").
 *
 * The transcript is a *permanent* record: a line written there stays for the whole
 * session, so a failure that the provider layer then recovered from (a 502 that was
 * retried, an empty response that was retried) left a stale error behind — the bug
 * the backlog reports. Such an attempt is not history, it is *news*, and news
 * belongs in a place that goes away on its own:
 *
 *  - **a notice is transient by construction.** Every notice carries an expiry
 *    (`at + ttlMs`, `NOTICE_TTL_MS` by default) and the overlay stops painting it
 *    once the clock passes it — no user action, no cleanup call.
 *  - **the newest news wins.** The overlay paints at most `NOTICE_MAX_ROWS` rows
 *    (oldest of the shown first) and keeps at most `NOTICE_MAX_KEPT` notices, so a
 *    retry loop can never grow it without bound.
 *  - **the same news is one row.** Repeating an identical kind+text refreshes that
 *    notice (and moves it back to the top) instead of stacking duplicates, which is
 *    what a retrying provider does.
 *  - **a recovered failure can be taken down.** `dismiss(id)` removes one notice by
 *    the handle `add()` returned, which is how a retry that finally succeeded stops
 *    being shown instead of sitting there for the rest of its TTL.
 *
 * Pure and terminal-free: the clock is injected, the rows come back as blessed tag
 * strings, and the model is unit testable without a screen. `app/notice-bar.js`
 * owns the widget and the timer; `app/tui.js` owns neither.
 */

/** How long a notice stays on screen: the "some minutes" the backlog asks for. */
export const NOTICE_TTL_MS = 3 * 60 * 1000;

/** Rows the overlay paints at once (the newest ones). */
export const NOTICE_MAX_ROWS = 3;

/** Notices the model remembers, so a retry loop cannot grow it without bound. */
export const NOTICE_MAX_KEPT = 20;

/** The kinds a notice can be, most severe last. */
export const NOTICE_KINDS = Object.freeze(['info', 'warn', 'error']);

/**
 * One colour per kind. `info` and `error` come from the conversation palette, so a
 * notice and the row it belongs with are painted the same; `warn` is the yellow the
 * palette already uses for a tool block — a retried attempt is not an error yet.
 *
 * The reads are **getters**, not snapshots: the palette is live
 * (`docs/interface/skins`), so a skin that repaints `notice`/`error` repaints the
 * notice rows with it instead of leaving them at the colours of import time.
 */
export const NOTICE_COLORS = Object.freeze(Object.defineProperties({}, {
  info: { get: () => CONVERSATION_COLORS.notice, enumerable: true },
  warn: { get: () => 'yellow', enumerable: true },
  error: { get: () => CONVERSATION_COLORS.error, enumerable: true },
}));

/** The glyph that introduces each kind, so severity survives a monochrome screen. */
export const NOTICE_MARKERS = Object.freeze({ info: 'ℹ', warn: '⚠', error: '✖' });

/** One notice is a one-liner: a long message is truncated, never wrapped. */
export const NOTICE_MAX_CHARS = 160;

/**
 * The body of a notice: sanitised first (raw control characters and blessed tags
 * can never reach the widget), flattened to a single line, truncated with an `…`.
 * Returns `''` for blank text, which `add()` refuses to store.
 */
export function formatNoticeText(text, maxChars = NOTICE_MAX_CHARS) {
  const flat = sanitize(text).replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const cap = Number.isFinite(Number(maxChars)) ? Math.max(0, Math.trunc(Number(maxChars))) : NOTICE_MAX_CHARS;
  if (cap === 0) return '';
  // Truncated between **grapheme clusters** (app/cell-width.js), so a notice carrying
  // an emoji keeps it whole instead of ending on half a sequence.
  return cutCodePoints(flat, cap);
}

/**
 * One painted row: the marker and the text in the kind's colour, the marker carrying the
 * severity. The colour goes through the tag layer (`app/paint-tags.js`) like every other
 * paint site, so a colour the terminal cannot paint never reaches the widget as a literal
 * tag (`docs/interface/skins`).
 */
export function formatNoticeRow(notice = {}) {
  const kind = NOTICE_KINDS.includes(notice.kind) ? notice.kind : 'info';
  const body = formatNoticeText(notice.text);
  return fgTag(NOTICE_COLORS[kind], `${NOTICE_MARKERS[kind]} ${body}`);
}

/**
 * The rows the overlay paints for a list of notices: at most `maxRows`, oldest of
 * the shown first, so the newest notice is the bottom row and never scrolls off.
 */
export function formatNoticeRows(notices = [], { maxRows = NOTICE_MAX_ROWS } = {}) {
  const cap = Number.isFinite(Number(maxRows)) ? Math.max(0, Math.trunc(Number(maxRows))) : NOTICE_MAX_ROWS;
  if (cap === 0) return [];
  return [...notices].slice(-cap).map(formatNoticeRow);
}

/**
 * The wording of a *retried* provider failure — the attempt that must not end up in
 * the transcript. It names the attempt, the total and the wait, so the notice says
 * "still going" rather than "failed".
 */
export function formatRetryNotice({ attempt = 1, maxRetries = 1, delayMs = 0, error = null } = {}) {
  const reason = error?.message ? String(error.message) : 'unknown error';
  const seconds = Number(delayMs) > 0 ? `, retrying in ${Math.round(Number(delayMs) / 1000)}s` : '';
  return `Provider call failed (attempt ${attempt}/${maxRetries}${seconds}): ${reason}`;
}

/** The wording of a failure nothing recovered from: the task ends on this one. */
export function formatFailureNotice(error) {
  const reason = error?.message ? String(error.message) : String(error ?? 'unknown error');
  return `Provider call failed: ${reason}`;
}

/**
 * The notice model.
 *
 * `now` is injected so the expiry is testable without waiting, and `add()` returns
 * the notice's id — the handle `dismiss()` and the conversation loop use to take a
 * recovered failure down.
 */
export function createNoticeOverlay({
  ttlMs = NOTICE_TTL_MS,
  maxRows = NOTICE_MAX_ROWS,
  max = NOTICE_MAX_KEPT,
  now = () => Date.now(),
} = {}) {
  const live = [];
  const listeners = new Set();
  let seq = 0;

  /** Drop everything past its expiry; returns how many notices went away. */
  const prune = (at = now()) => {
    let removed = 0;
    for (let i = live.length - 1; i >= 0; i -= 1) {
      if (live[i].expiresAt <= at) {
        live.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  };

  const notify = () => {
    const rows = formatNoticeRows(live, { maxRows });
    for (const listener of [...listeners]) {
      try {
        listener(rows);
      } catch {
        // display only: a broken overlay must never break the conversation
      }
    }
    return rows;
  };

  return {
    /** The clock the expiry is measured against (injected, so it is testable). */
    now,
    /**
     * Add (or refresh) a notice and return its id, or null when there is nothing to
     * show. An identical kind+text is the *same* notice refreshed, never a second
     * row: a provider that fails twice with the same message leaves one line.
     */
    add(kind, text, options = {}) {
      const body = formatNoticeText(text);
      if (!body) return null;
      const at = now();
      const ttl = Number.isFinite(Number(options.ttlMs)) ? Math.max(0, Number(options.ttlMs)) : ttlMs;
      const resolved = NOTICE_KINDS.includes(kind) ? kind : 'info';

      let entry = live.find((notice) => notice.kind === resolved && notice.text === body);
      if (entry) {
        entry.at = at;
        entry.expiresAt = at + ttl;
        live.splice(live.indexOf(entry), 1);
      } else {
        seq += 1;
        entry = { id: seq, kind: resolved, text: body, at, expiresAt: at + ttl };
      }
      live.push(entry);
      while (live.length > max) live.shift();

      notify();
      return entry.id;
    },

    /** Remove one notice by the id `add()` returned; false when it is already gone. */
    dismiss(id) {
      const index = live.findIndex((notice) => notice.id === id);
      if (index < 0) return false;
      live.splice(index, 1);
      notify();
      return true;
    },

    /** Drop every notice (the overlay hides itself again). */
    clear() {
      const had = live.length;
      live.length = 0;
      notify();
      return had;
    },

    /** Expire what is due and return the rows the overlay should paint right now. */
    rows(options = {}) {
      prune();
      return formatNoticeRows(live, { maxRows: options.maxRows ?? maxRows });
    },

    /** Expire what is due and hand back a copy of what is left, oldest first. */
    get notices() {
      prune();
      return live.map((notice) => ({ ...notice }));
    },

    /** How many notices are live right now. */
    get size() {
      prune();
      return live.length;
    },

    /** When the earliest live notice expires (ms since epoch), or null. */
    nextExpiry() {
      prune();
      if (live.length === 0) return null;
      return live.reduce((soonest, notice) => Math.min(soonest, notice.expiresAt), Infinity);
    },

    /** Subscribe to every change; returns the unsubscribe function. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Forget every subscriber (teardown). */
    close() {
      listeners.clear();
    },

    prune,
    formatRows: (options) => formatNoticeRows(live, options),
  };
}

/**
 * Define the notice surface the host loop and the tests use onto `target`:
 * `notice(kind, text)` adds one and returns its handle, `dismissNotice(handle)`
 * takes a recovered failure down, `notices`/`noticeRows` are read-only views.
 *
 * Defined rather than spread, like `queueSurface`: spreading an object literal
 * evaluates its getters once and would freeze `notices` at build time.
 */
export function noticeSurface(overlay, target = {}) {
  return Object.defineProperties(target, {
    /** Show a transient notice; returns its handle (null for blank text). */
    notice: { value: (kind, text, options) => overlay.add(kind, text, options), enumerable: true },
    /** Take one notice down by handle (a failure that recovered). */
    dismissNotice: { value: (id) => overlay.dismiss(id), enumerable: true },
    /** Drop every notice; the overlay hides itself again. */
    clearNotices: { value: () => overlay.clear(), enumerable: true },
    /** The live notices, oldest first (a copy: mutating it changes nothing). */
    notices: { get: () => overlay.notices, enumerable: true },
    /** The rows the overlay paints right now (used by the tests). */
    noticeRows: { value: (options) => overlay.rows(options), enumerable: true },
    /** The notice model itself, for callers that need its whole surface. */
    noticeOverlay: { value: overlay, enumerable: true },
  });
}
