# i cant consistently cancel the operation with ctrl+c or event exit the app with esc, so these controls must be fixed

status: in progress: i cant consistently cancel the operation with ctrl+c or event exit the app with esc, so these controls must be fixed

## Steps

- [ ] utils/keys.js already provides isInterruptKey(); confirm AbortManager imports it
- [ ] cli.js: add exit() that resolves the pending question with 'exit' and closes rl
- [ ] tui.js: forward Escape/Ctrl+C to options.onInterrupt via isInterruptKey and add exit() resolving the armed prompt with 'exit'
- [ ] main.js: pass onExit (cli.exit) and confirmMode to AbortManager, forward tui onInterrupt to abortManager.interrupt(), and bail out of the loop when the input is 'exit'
- [ ] Verify: node --check on changed files, node --test, and probe-interrupt.mjs
- [ ] Update the help line text in main.js to describe Esc/Ctrl+C behaviour
