status: done

# Backlog pick: "conversation should include the messages from the user too"

Source: `task-backlog.md` item 2. Work it one checkbox at a time with the
`update_task` loop (start → implement → verify → complete), and keep the three
realms linked: code in `app/` + `main.js`, proof in `tests/`, contract in `docs/`.

- [x] the user's message is echoed: ConversationManager announces it through onUserMessage and formatUserEcho() renders it
- [x] tests/user-echo.test.js proves the echo, the quote colouring and the untouched chunk
- [x] docs/interface/user-messages describes the behaviour and links the new cases
- [x] full suite is green and the picked backlog item is marked done in task-backlog.md
