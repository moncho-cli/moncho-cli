// Probe for item 1: with captureKeys:false the AbortManager must not install a
// second process.stdin 'keypress' listener (the TUI owns stdin), while the
// default (line-based CLI) still installs exactly one. dispose() must remove
// everything it added.
import { AbortManager } from './app/abort-manager.js';

const keypress = () => process.stdin.listenerCount('keypress');
const sigint = () => process.listenerCount('SIGINT');

const baseline = { keypress: keypress(), sigint: sigint() };

const tuiMode = new AbortManager(null, { captureKeys: false });
const afterTuiMode = { keypress: keypress(), sigint: sigint() };
tuiMode.dispose();
const afterTuiDispose = { keypress: keypress(), sigint: sigint() };

const cliMode = new AbortManager(null);
const afterCliMode = { keypress: keypress(), sigint: sigint() };
cliMode.dispose();
const afterCliDispose = { keypress: keypress(), sigint: sigint() };

console.log('baseline            ', baseline);
console.log('captureKeys:false   ', afterTuiMode);
console.log('  after dispose()   ', afterTuiDispose);
console.log('captureKeys:default ', afterCliMode);
console.log('  after dispose()   ', afterCliDispose);

const ok =
  afterTuiMode.keypress === baseline.keypress &&
  afterTuiDispose.keypress === baseline.keypress &&
  afterCliMode.keypress === baseline.keypress + 1 &&
  afterCliDispose.keypress === baseline.keypress &&
  afterCliDispose.sigint === baseline.sigint;

console.log(ok ? 'OK: no duplicate stdin listener in TUI mode' : 'FAIL');
process.exit(ok ? 0 : 1);
