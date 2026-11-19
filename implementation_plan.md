# interface: Tab cycles Chat -> Design -> Work in the TUI and is refused while work:on, with a notice explaining the lock

status: in progress: interface: Tab cycles Chat -> Design -> Work in the TUI and is refused while work:on, with a notice explaining the lock

## Steps

- [ ] read app/tui-keys.js and app/session-loop.js to see where Tab can be bound
- [ ] add the Tab binding that calls sessionMode.cycle() and shows WORK_LOCK_NOTICE on a refusal
- [ ] surface the lock notice through the TUI notice bar, not the transcript
- [ ] cover it in tests/session-mode.test.js or a new session-keys suite
- [ ] register the capability in docs/interface/modes and run npm test
