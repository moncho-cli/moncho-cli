# Interface — the design review

`design` is the mode whose whole job is turning a discussion into a checklist
(`docs/interface/modes`). The file that discussion produces — `task.md` — is the thing the
user is meant to be reviewing, and before this capability existed they had to type `/task`
after every turn to see it. The review is the answer: **the moment thinking stops and the
session is waiting for a person again, the checklist is put back on screen.**

The backlog entry, and the two halves of it:

> when the mode is Design, everytime the thinking stops to wait for the user action, it has
> to print in the user conversation the content of task.md to review, do it deterministically
> dont expect the model to know this or do it. by code, when thinking stops to get a user
> message, inject into the user convo (not the model context)

## It is host code, at the turn boundary

- **The model is not involved.** No tool call, no instruction in the agent prompt, nothing the
  model has to remember: the boundary between "the model is thinking" and "the session waits
  for a person" is the host's to observe, and it observes it in one place —
  `app/session-loop.js#runSessionLoop` shows the review in the `finally` of the turn it just
  ran. A behaviour the model had to remember would be a behaviour the agent may or may not
  perform; this one cannot be forgotten.
- **Two ways a turn settles count.** A turn that *lands* and a turn the user *aborts* both
  end with reasoning stopped and the keyboard back, so both review the checklist. A failure
  that propagates out of the loop is not that moment — the process is leaving — so it does
  not. The loop states this as one `settled` flag rather than two call sites.
- **The decision is read live.** `shouldReviewDesign()` asks the session's mode object on
  every turn, so a `Tab` pressed mid-session moves the behaviour with the mode and nothing
  has to be re-registered. `work:on` pins the mode to `work`, so the execution lock needs no
  second test: the locked state simply is not `design`.

## Presentation only, and it says it once

- **The block goes to the transcript's own sink.** `logBlock` is the route every view-only
  announcement already takes (`docs/interface/tracking-block`), so the review is a block in
  the conversation and **nothing else**: not a chunk, not a session file, never part of the
  request sent to the provider. "Into the user conversation, not the model context" is a
  property of the route, not a promise about it — `app/design-review.js` imports the tracking
  store, the palette and the file-name constant, and no route to the window or a provider.
- **An unchanged checklist is not re-dumped.** A review is worth reading because it says what
  changed; a design turn that touched no file would otherwise repeat the same sixty lines
  after every exchange, which teaches the user to scroll past it. The rule is still
  deterministic — the bytes are compared against the bytes last shown — it just refuses to
  say the same thing twice. `reset()` forgets what was shown.
- **The block reads as a tracking milestone**, because that is what it is: the header carries
  the `[Tracking]` marker the palette recognises (so it paints like every other tracking row),
  opens with the file's own name, says `design review` and how many lines it carries; the body
  is the checklist **verbatim**; and `bodyColor` is the tracking colour, read **live** so a
  skin that moves it moves the review too (`docs/interface/skins`).
- **Silence is a valid answer, and never an empty box.** No `design` mode, no block sink (the
  line CLI, a bare tool call), no `task.md` yet, or the same bytes as last time: nothing is
  shown. A reader that throws is contained too — reading `task.md` is a courtesy here, and it
  must never cost the user the turn that just landed.

## Why the mode object, and not a boolean

The reviewer takes the session mode itself rather than a `isDesign` flag, so the one fact it
needs — the live mode — has exactly one source. A boolean passed at construction would freeze
the mode the session happened to open in and leave the review behind on the first `Tab`, which
is the bug the item was reported from (`docs/interface/modes`).

## See also

- Implementation: `app/design-review.js`, `app/session-loop.js`, `main.js`
- The mode whose turn it follows: `docs/interface/modes`
- The block shape and its colour it shares: `docs/interface/tracking-block`
- The file it reads: `docs/agent/task-tracking`
- The read-only viewer the same content opens on demand: `docs/interface/task-viewer`
- Proof: `tests/design-review.test.js`
