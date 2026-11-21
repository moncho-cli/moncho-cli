# The project's own rule book

The agent prompt (`config/prompt.md`) is Moncho's rule book: how it works, everywhere.
A repository has a rule book of its own — indentation, test layout, which files are
generated, which command is the one that really runs the suite — and in the convention
this project already uses those rules live in one `AGENTS.md` at the project root.

The model never saw that file. Item 50 of the backlog is the gap: a session in a foreign
repository was governed only by the agent's habits, so a rule the repository states plainly
was one the agent could only learn by being corrected.

## Where it rides

`utils/project-rules.js#projectRulesMessage` returns one `system` message, and
`app/conversation-manager.js#beginModelCall` puts it in the **request prelude** — the same
seam `docs/agent/session-context` uses, for the same reasons:

- **it is project data, not conversation.** It never becomes a window chunk, never reaches
  `context.json`, never replays into a TUI, and a compaction cannot evict it;
- **it is read again on every call**, so a rule the user or the model edits mid-session
  takes effect on the next request rather than the next resume. The read is keyed on the
  file's size and mtime, so an unchanged file costs one `stat` and no parse;
- **absence is silence.** No file, an empty file or an unreadable one answers `null`, and
  the request goes out exactly as it did before this module existed.

## What it says

The block is introduced before the file's text and settles two questions the model would
otherwise have to guess at:

1. **which rules win.** The project's rules sit on top of the agent's own: where the two
   disagree about *this* repository, the project wins.
2. **what language applies where.** The conversation may follow the user; the code, the
   artefacts and the tasks stay in the project's own. That is the whole of backlog item 62,
   and it costs one line here instead of an environment variable elsewhere.

## The three bounds

- **The user flow only.** `config/constants.js#hostFenceEnabled` already answers "is this a
  user's project rather than the maintainer's own checkout?", and the block reuses it. For
  the maintainer, `prompt.md` *is* the project's rules, so quoting this repository back to
  itself would only spend context to say what is already said.
- **A hard size bound.** A request carries at most `MAX_RULES_CHARS` of the file. A longer
  one is cut **and the block says it was cut**, naming the path to read for the remainder.
  Silent truncation would hand the model a rule set it believes is complete.
- **The path goes through the sandbox.** The default read resolves `AGENTS.md` with
  `utils/path-safety.js#resolveProjectPath`, the same door every file tool uses, so the
  block cannot be pointed outside the project.

## Why this is not a tool

Nothing here is an action the model chooses to take. A rule book that must be *remembered*
to be consulted is consulted exactly when it is least needed; handing it over on every
request makes the project's rules ambient instead of a step in a procedure.