# Interface — commands submitted while a turn is in flight

The pending-message queue exists for **prompts**: a turn can take minutes, and a
message typed during one has to survive until the next turn
(`docs/interface/message-queue`). A **slash command** is not a message for the
model — `/task`, `/help` and `/usage` answer locally and never reach the provider —
so queueing one is wrong twice over: the user waits a whole turn for an answer that
is already available, and the queue row claims a prompt that will never be sent.

The backlog says it plainly:

> slash commands like /task (there are probably others) should not be queued, as
> those are not messages for the model, they need to be able to be ran in parallel
> while the model thinks

## the verdict is deterministic

`busyVerdict()` (`app/busy-command.js`) answers what a submission means while a turn
is in flight: `null` for anything that is not a command (a prompt, which the queue
keeps), `run` for a command that only reads state, `refuse` otherwise.

The classification is **declared by the command itself**, not kept in a list here:
a read-only command carries `busy: 'parallel'` on its own object. `/help`, `/usage`
and `/task` declare it; every other command — `/new`, `/sessions`, `/compact`,
`/work`, `/ref`, `/skins` — is deferred, and so is any command registered later that
declares nothing.

**The default is the safe half deliberately.** Those deferred commands really do
mutate the state a live turn is appending to: `/new` empties the context window,
`/sessions` replaces it, `/compact` rewrites it, `/ref` overwrites the tracking
pair. Running one underneath a running turn would corrupt exactly what that turn is
writing, so a command that forgets to declare itself is refused mid-turn rather than
answered. An unknown name is refused with the same wording the host loop uses between
turns, so a typo never waits for a turn either.

## the answer never waits

A submission reaches the input machine with no armed question while a request is in
flight (`app/prompt-input.js#submit`). Before the queue is asked, the host's
mid-turn handler is consulted; when it consumes the input the box is emptied and
re-armed exactly as the queued path leaves it, so the next keystroke of a long turn
still lands. A command is therefore answered **inside** the turn, in parallel, which
is what "ran in parallel while the model thinks" means for one process.

The runner (`createBusyCommandRunner`) makes two choices that follow from being
called from a key handler:

- it decides **synchronously** and works **asynchronously** — a command that opens a
  modal (`/task`) or awaits a provider call is started and left to finish, because a
  keystroke cannot wait for it;
- a command that throws is reported through `notify` (the notice overlay, or the line
  CLI's plain line) and never thrown into the keystroke, because a broken command
  must not take the input box down with the turn still running. The notice is a **red**
  one and reads `/<name> failed: <message>`.

  That reporting is honest, which is why it is worth stating what it cannot tell you: a
  `ReferenceError` from an undeclared identifier looks exactly like a broken command. It
  happened — `main.js` passed `skinSubchat` to `runSessionLoop()` as an object *property*
  and then named it as a bare identifier inside the mid-turn `run` closure, where no such
  binding existed, so every mid-turn `/task` showed
  `/task failed: skinSubchat is not defined` for a command that worked perfectly between
  turns. The fix was to hoist the subchat into a real `const`, and the reason it escaped
  every test is worth keeping: the mid-turn tests all inject their own stand-in `run`, so
  none of them ever evaluates the host's closure. A defect that is statically knowable
  needs a static guard, so `tests/busy-command-wiring.test.js` reads `main.js` and refuses
  a shorthand property in that closure naming an identifier the file never declares —
  and it was confirmed to fail against the bug before it was trusted.

## one path, two moments

A command answered mid-turn runs through the very same `handleCommand()` the loop
uses between turns (`app/session-loop.js`), so it behaves identically whenever it is
typed — the moment it was submitted is the only difference. A front end with no input
box (the line CLI) has no mid-turn handler installed and is unchanged: its readline
buffer already delivers input at the next `question()`.

## See also

- Implementation: `app/busy-command.js` (the verdict and the runner),
  `app/prompt-input.js#submit` (the mid-turn branch),
  `app/tui-input-stack.js` (the late-bound installation), `app/session-loop.js`,
  `main.js`
- Spec of the queue this keeps a command out of: `docs/interface/message-queue`
- Spec of the commands themselves: `docs/interface/commands`
- Spec of the notice the refusal uses: `docs/interface/notice-overlay`
- Proof: `tests/busy-command.test.js`