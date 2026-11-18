// Probe: what does the input box itself do with ESC while it is reading input?
// textarea._listener:  if (key.name === 'escape') done(null, null)  -> emits 'cancel',
// stops reading, restores focus and re-runs rewindFocus (which may re-focus the box,
// and textarea binds 'focus' -> readInput, i.e. the box may re-arm itself).
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

const events = [];
const tui = createTui({ input, output, modelLabel: 'probe' });
tui.inputBox.on('cancel', (v) => events.push(`cancel(${v})`));
tui.inputBox.on('submit', (v) => events.push(`submit(${v})`));
tui.inputBox.on('blur', () => events.push('blur'));
tui.inputBox.on('focus', () => events.push('focus'));

const state = () => `reading=${tui.inputBox._reading} focused=${tui.screen.focused === tui.inputBox} grabKeys=${tui.screen.grabKeys}`;

const answered = tui.question('> ');
await new Promise((r) => setImmediate(r));
events.push(`after question: ${state()}`);

// The real path: the terminal decodes ESC and the focused widget receives it.
tui.inputBox.emit('keypress', '\x1b', { name: 'escape', full: 'escape' });
events.push(`after escape emit: ${state()}`);
await new Promise((r) => setImmediate(r));
await new Promise((r) => setImmediate(r));
events.push(`after escape, next ticks: ${state()}`);

// Does the box still accept typed characters?
tui.inputBox.emit('keypress', 'a', { name: 'a', full: 'a' });
events.push(`after typing 'a': value=${JSON.stringify(tui.inputBox.getValue())} ${state()}`);

// Ctrl+C is a control byte: does the widget touch it at all?
tui.inputBox.emit('keypress', '\x03', { name: 'c', ctrl: true, full: 'C-c' });
events.push(`after ctrl+c: value=${JSON.stringify(tui.inputBox.getValue())} ${state()}`);

console.log(events.join('\n'));
console.log('pending promise still unresolved:', answered instanceof Promise);
void answered;
tui.close();
input.destroy();
output.destroy();
process.exit(0);
