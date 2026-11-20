# Interface — transient notices in a self-hiding overlay

> clean up failed attempts, i got a 502 error then it worked but the error text was
> still there. this info should also be displayed in some kind of overlay near the
> top of the screen and auto hide after some minutes

Two bugs in one report. The first is the *stale error*: a provider attempt failed,
the retry loop tried again and succeeded, and the error text stayed on screen for
the rest of the session. The second is the *place*: a failure is loud enough to
deserve more than a line scrolling past in a transcript.

## News is not history

The transcript is a **permanent record** — a line written there is never removed, by
design: it is what the conversation *was*. An attempt the provider layer then
recovered from is not part of that record, it is **news**, and news belongs
somewhere that goes away on its own.

So the two are split at the source:

- `api/ollama.js` reports every attempt it is about to **retry** through an injected
  `onRetry({ attempt, maxRetries, delayMs, error })` hook. With a hook, nothing is
  written to the console; without one the previous `console.warn` line is kept, so
  the provider stays usable on its own.
- `app/conversation-manager.js` turns that report into a **notice**
  (`notifyRetry()`) and never into a transcript line. A `null`/empty response — which
  the loop retries — is a notice for the same reason.
- The failure that **ends the task** keeps its transcript line *and* raises an
  `error` notice: nothing recovered from it, so it is both news and history.
- `main.js` keeps the handle of the current retry notice and dismisses it the moment
  the turn lands, so a recovered 502 disappears at once rather than at its TTL.

`notifyNotice()`/`notifyRetry()`/`notifyProse()` are presentation only, exactly like
`onUserMessage` and `onContextChange`: a hook that throws is swallowed, and a
manager without a hook drops the message instead of falling back to the transcript
(that fallback *is* the bug). The line CLI, which has no floating box, prints the
notice as a plain line — same information, different place
(`docs/interface/line-cli`).

## The notice model

`app/notice-overlay.js` is pure and terminal-free: the clock is injected, the rows
come back as blessed tag strings, and every rule below is unit tested without a
screen.

| Rule | Behaviour |
| ---- | --------- |
| **transient** | every notice carries `at + ttlMs` (`NOTICE_TTL_MS`, three minutes) and stops being painted once the clock passes it — no user action, no cleanup call |
| **bounded** | at most `NOTICE_MAX_ROWS` (3) rows are painted and at most `NOTICE_MAX_KEPT` (20) notices are remembered, so a retry loop cannot grow the overlay without bound |
| **deduplicated** | an identical kind+text **refreshes** that notice (and its TTL) instead of stacking a second row, which is exactly what a retrying provider produces |
| **dismissable** | `add()` returns a handle and `dismiss(id)` takes that one notice down, which is how a recovered failure stops being shown |
| **legible** | one sanitised, flattened, truncated line per notice, introduced by a severity marker (`ℹ` / `⚠` / `✖`) and painted in the kind's colour (`info`/`error` from `docs/interface/conversation-colors`, `warn` yellow) |

A blank message is not a notice at all (`add()` returns `null`), and an unknown kind
degrades to `info` rather than painting an undefined colour.

## The overlay

`app/notice-bar.js` binds the model to the screen:

- a **borderless floating box**, the width of the screen, hanging from an `anchor`.
  It sits *over* the top of the transcript instead of taking a row from it, so the
  regions below never move and the reader's scroll position is untouched. The anchor
  is re-read on every paint: it is one row under the brand line
  (`docs/interface/brand-line`), so a notice never covers the mark, and it follows
  the conversation back to the top edge when a narrow window hides the mark.
- **hidden while nothing is live** (`hidden: true`, `height: 0`), so a quiet session
  shows no chrome at all.
- **self-hiding on one timer**, armed for the *earliest* expiry rather than for a
  fixed interval: no repaint loop runs between notices, and the timer is `unref`'d so
  a pending notice never keeps the process alive.
- every mutation of the model (add, dismiss, clear) repaints through the model's
  subscription: the widget is a **view** of the model, never a second copy of it.

The surface is attached to the TUI as `notice(kind, text)` / `dismissNotice(id)` /
`clearNotices()` / `notices` / `noticeRows()` (`noticeSurface()`, defined rather than
spread so the accessors stay live).

## See also

- Implementation: `app/notice-overlay.js` (the model), `app/notice-bar.js` (the
  overlay), `app/tui-surface.js` (the public surface), `api/ollama.js` (the
  `onRetry` hook), `app/conversation-manager.js` (the `onNotice` routing), `main.js`
  (the binding and the dismiss-on-success)
- Spec of the palette the notice colours come from: `docs/interface/conversation-colors`
- Spec of the transcript the notices stay out of: `docs/interface/tui`
- Spec of the front end without a floating box: `docs/interface/line-cli`
- Spec of the provider retry loop that reports them: `docs/runtime/provider-calls`
- Proof: `tests/notice-overlay.test.js`, `tests/conversation-manager.test.js`
