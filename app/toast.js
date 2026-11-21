/**
 * The short-lived confirmation model: one message, four seconds, gone again.
 *
 * Deliberately **not** the transient-notice overlay (`app/notice-overlay.js`). That one
 * reports what the *provider* did — a retry, a failure — keeps three rows, holds them for
 * three minutes and spans the screen, because a reader who looked away must still find it
 * there. A copy confirmation is the opposite kind of news: the reader just did the thing,
 * knows what they did, and needs only a flicker of proof. So it has its own clock, its own
 * four seconds, and one corner instead of a band across the top.
 *
 * Pure: the clock is injected and the message is a plain string, so the whole model is
 * testable without a screen. The binding is `app/tui-toast.js`.
 */

/** How long a toast stays up: long enough to notice, short enough not to nag. */
export const TOAST_TTL_MS = 4000;

/** The longest message the box is sized for; past this it is truncated with an `…`. */
export const TOAST_MAX_CHARS = 60;

/**
 * The sentence a copy shows, built from the file it landed in.
 *
 * The name is in the sentence because the name is the *point*: the reader's next move is
 * to open that file, and a sentence without it would leave them to guess or to search.
 * The workspace is not repeated — the reader is already standing in it.
 *
 * Deliberately not a character count: the count answers a question nobody asked ("how much
 * did I copy?") while the sentence answers the one they did ("where did my text go?").
 */
export function savedToastText(file) {
  const name = String(file ?? '').trim();
  return name ? `Saved data to ${name}` : 'Saved data to a clipboard file';
}

/** The prefix of the copy sentence, kept as a constant so the wording is one decision. */
export const SAVED_TOAST_TEXT = 'Saved data to';

/** Fit `text` to the toast's width, cutting between grapheme clusters with an `…`. */
export function formatToastText(text, maxChars = TOAST_MAX_CHARS) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const cap = Math.max(1, Math.trunc(Number(maxChars)) || TOAST_MAX_CHARS);
  const clusters = [...flat];
  if (clusters.length <= cap) return flat;
  return `${clusters.slice(0, Math.max(0, cap - 1)).join('')}…`;
}

/**
 * The toast model: at most one message at a time, replaced (never stacked) by the next.
 *
 * Replacing is the right shape: a second copy a moment after the first is the same news,
 * and two identical boxes would be noise. The expiry is recomputed, so the reader gets the
 * full four seconds measured from the latest event.
 */
export function createToast({ ttlMs = TOAST_TTL_MS, now = () => Date.now() } = {}) {
  const listeners = new Set();
  let message = '';
  let expiresAt = 0;

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener(message);
      } catch {
        // display only: a broken toast must never break the conversation
      }
    }
  };

  /** Drop the message once its time is up; true when something expired. */
  const prune = (at = now()) => {
    if (!message || expiresAt > at) return false;
    message = '';
    expiresAt = 0;
    return true;
  };

  return {
    now,
    /** Show `text` for the toast's lifetime; blank text is not a toast. */
    show(text) {
      const body = formatToastText(text);
      if (!body) return null;
      message = body;
      expiresAt = now() + Math.max(0, Number(ttlMs) || 0);
      notify();
      return body;
    },
    /** The message on screen right now, or '' when there is none. */
    get current() {
      prune();
      return message;
    },
    /** True while a toast is up. */
    get visible() {
      return this.current !== '';
    },
    /** When the live toast expires (ms since epoch), or null when idle. */
    nextExpiry() {
      prune();
      return message ? expiresAt : null;
    },
    /** Hide it now (a teardown, or a newer message superseding it). */
    hide() {
      const had = message !== '';
      message = '';
      expiresAt = 0;
      if (had) notify();
      return had;
    },
    /** Subscribe to every change; returns the unsubscribe function. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Forget every subscriber and the message (teardown). */
    close() {
      listeners.clear();
      message = '';
      expiresAt = 0;
    },
    prune,
  };
}