// Probe: how many times does one physical Ctrl+C byte reach an interested party
// in the line-based CLI? readline turns ^C into an interface-level SIGINT and our
// own stdin keypress listener may see the same byte, so the delivery order and
// count decide whether interrupt() must be deduplicated.
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

readline.emitKeypressEvents(input);
input.on('keypress', (ch, key) => {
  log.push(`stdin keypress ${JSON.stringify(key?.full || key?.name || ch)}`);
});

const rl = readline.createInterface({ input, output, terminal: true });
rl.on('SIGINT', () => log.push('rl SIGINT'));

// readline writes its question prompt, no answer needed here.
rl.question('> ', () => log.push('answer'));

log.push('--- emitting \\x03 as a decoded ctrl+c keypress ---');
input.emit('keypress', '\x03', { name: 'c', ctrl: true, sequence: '\x03' });

log.push('--- emitting \\x1b as escape ---');
input.emit('keypress', '\x1b', { name: 'escape', sequence: '\x1b' });

log.push('--- raw data \\x03 through the decoder ---');
input.write('\x03');

setImmediate(() => {
  console.log(log.join('\n'));
  console.log('raw mode after question:', input.isRaw);
  process.exit(0);
});
