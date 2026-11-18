# **reload the conversation view when a session is resumed** — extract the shared tool-call formatting, add the pure chunk→transcript replay, wire it into the host after `RESUMED` for both front ends, make the recorder adopt the resumed session id, and prove it with a `docs/interface/session-replay` spec (registered in `docs/index.yaml`) plus named cases in `tests/session-replay.test.js`.

status: done

## Steps

- [ ] Extract the shared tool-call formatting into app/tool-call-format.js (formatArgs, normalizeToolCall(s), formatCallLines, formatToolHeader, formatToolResultChunk, parseToolChunk) and route ConversationManager through it
- [ ] Add app/session-replay.js: replayChunks() (chunk -> render ops matching tool results to their call by id), renderReplay() (TUI blocks vs plain CLI lines) and reloadConversation()
- [ ] Give the transcript view clear(), the TUI a reload(chunks) that also resets the compaction notifier, and the commands RESUMED result the loaded chunks plus metadata
- [ ] Add adopt(id, { createdAt, model }) to the recorder and wire main.js to reload the view and adopt the resumed id before printing the result
- [ ] Write docs/interface/session-replay (behaviour.md + spec.yaml), register it in docs/index.yaml and cross-reference it from commands, tui, transcript and session-store specs
- [ ] Add tests/session-replay.test.js (9 cases) and run npm test green: 221 tests, docs-realm included; node --check clean, no file over 300 lines
