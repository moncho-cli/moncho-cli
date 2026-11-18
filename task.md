status: done

# Backlog pick: "grep tool is missing the After and Before arguments to be able to return context lines"

Source: `task-backlog.md` item 1. Work it one checkbox at a time with the
`update_task` loop (start → implement → verify → complete), and keep the three
realms linked: code in `tools/grep.js`, proof in `tests/`, contract in `docs/`.

- [x] grep accepts "before"/"after" arguments and returns the surrounding context lines
- [x] tests in tests/grep-context.test.js prove context lines, overlap merging and caps
- [x] docs/agent/project-discovery describes the context arguments and links the new cases
- [x] full suite is green and the picked backlog item is marked done