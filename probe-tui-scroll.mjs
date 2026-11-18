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
const log = blessed.log({ top: 0, bottom: 4, left: 0, right: 0, scrollable: true, alwaysScroll: true, tags: false });
screen.append(log);
screen.render();
screen.program.flush();
for (let i = 0; i < 200; i++) log.log('line ' + i);
screen.render();
screen.program.flush();

console.log('childBase after render', log.childBase, 'height', log.height, 'getScroll', log.getScroll(), 'getScrollHeight', log.getScrollHeight());
log.scroll(-1);
console.log('after scroll(-1) no render -> childBase', log.childBase, 'getScroll', log.getScroll());
screen.render();
console.log('after render -> childBase', log.childBase, 'getScroll', log.getScroll());
log.setScrollPerc(50);
console.log('after setScrollPerc(50) -> childBase', log.childBase, 'getScroll', log.getScroll());
screen.render();
console.log('after render -> getScroll', log.getScroll(), 'perc', log.getScrollPerc());
process.exit(0);
