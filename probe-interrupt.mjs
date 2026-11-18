// Probe for item 2: where the interrupt keys go depending on who owns stdin.
//
// The goal is to observe, without a real pty:
//   1. whether the input box still owns stdin (screen.grabKeys) while a task runs,
//   2. whether Escape / Ctrl+C reach a screen-level listener or only the widget,
//   3. what the widget does with them (cancel event / swallowed).
import { PassThrough } from 'node:stream';
import { createTui } from './app/tui.js';

function fakeTty() {
  const s = new PassThrough();
  s.isTTY = true;
  s.columns = 80;
  s.rows = 24;
  return s;
}

const input = fakeTty();
const output = fakeTty();
output.resume();

const seen = { screen: [], widget: [] };
const tui = createTui({ input, output, modelLabel: 'probe' });

tui.screen.on('keypress', (ch, key) => seen.screen.push(key?.full || key?.name || ch));
tui.inputBox.on('keypress', (ch, key) => seen.widget.push(key?.full || key?.name || ch));
tui.inputBox.on('cancel', () => seen.widget.push('cancel-event'));

const grab = () => `grabKeys=${tui.screen.grabKeys} reading=${tui.inputBox._reading} focused=${tui.screen.focused === tui.inputBox}`;

console.log('idle before question :', grab());

const answered = tui.question('> ');
console.log('while awaiting input :', grab());

tui.inputBox.emit('submit', 'hi');
await answered;
console.log('while task runs      :', grab());

// How the app's own keypress listener sees the two interrupt keys.
const escapeKey = { full: 'escape', name: 'escape' };
const ctrlCKey = { full: 'C-c', name: 'c', ctrl: true };

tui.screen.emit('keypress', null, escapeKey);
tui.screen.emit('keypress', '\x03', ctrlCKey);
tui.screen.program.emit('keypress', null, escapeKey);
tui.screen.program.emit('keypress', '\x03', ctrlCKey);

console.log('screen listeners saw :', JSON.stringify(seen.screen));
console.log('widget listeners saw :', JSON.stringify(seen.widget));
console.log('state after ctrl+c   :', grab());

tui.close();
input.destroy();
output.destroy();
process.exit(0);
