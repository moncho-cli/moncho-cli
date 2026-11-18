import { PassThrough } from 'node:stream';
import blessed from 'neo-blessed';

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

const screen = blessed.screen({ input, output, smartCSR: true, warnings: false });
const log = blessed.log({ top: 0, bottom: 4, left: 0, right: 0, label: ' C ', scrollable: true, alwaysScroll: true, tags: false });
screen.append(log);
screen.render();
screen.program.flush();

for (let i = 0; i < 200; i++) log.log('line ' + i);
screen.render();
screen.program.flush();
log.setScrollPerc(100);
const before = log.getScroll();
console.log('scrollHeight', log.getScrollHeight(), 'before', before);

let fired = 0;
screen.key(['pageup', 'S-up'], () => { fired++; console.log('pageup handler fired'); });
console.log('after screen.key, listeners keypress:', screen.listeners('keypress').length, '_listenKeys?', typeof screen._listenKeys);

screen.emit('keypress', null, { name: 'pageup', full: 'pageup' });
screen.program.emit('keypress', null, { name: 'pageup', full: 'pageup' });
console.log('fired', fired, 'scroll after', log.getScroll());
process.exit(0);
