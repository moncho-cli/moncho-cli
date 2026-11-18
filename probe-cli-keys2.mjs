// Probe: in the line-based CLI, is the readline interface-level SIGINT still
// delivered after the pending question has been answered (i.e. while a task is
// running)? If yes, Ctrl+C can be handled there and the stdin keypress listener
// only has to cover Escape, which avoids double-firing interrupt().
import readline from 'readline';
import { PassThrough } from 'node:stream';

function fakeTty() {
  const s = new PassThrough();
  s.isTTY = true;
  s.columns = 80;
  s.rows = 24;
  s.isRaw = false;
  s.setRawMode = (v) => { s.isRaw = v; };
  return s;
}

const input = fakeTty();
const output = fakeTty();
const log = [];

const rl = readline.createInterface({ input, output, terminal: true });
rl.on('SIGINT', () => log.push('rl SIGINT'));

const answered = new Promise((resolve) => rl.question('> ', resolve));
input.emit('keypress', 'h', { name: 'h', sequence: 'h' });
input.emit('keypress', '\r', { name: 'enter', sequence: '\r' });
log.push(`answer=${await answered}`);

log.push('--- task running, ctrl+c keypress through readline ---');
input.emit('keypress', '\x03', { name: 'c', ctrl: true, sequence: '\x03' });
log.push('--- task running, escape keypress ---');
input.emit('keypress', '\x1b', { name: 'escape', sequence: '\x1b' });
log.push(`closed after ctrl+c? ${rl.closed}`);

console.log(log.join('\n'));
process.exit(0);
