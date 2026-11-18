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

const tui = createTui({ input, output });
const t = tui.transcript;

for (let i = 0; i < 200; i++) tui.log('line ' + i);

const dump = (label) => {
  console.log(label, {
    childBase: t.childBase,
    childOffset: t.childOffset,
    getScroll: t.getScroll(),
    getScrollHeight: t.getScrollHeight(),
    getScrollPerc: t.getScrollPerc(),
    height: t.height,
  });
};

dump('after logs');
tui.setStatus('probe');
tui.setStatus('probe2'); // no-op style
tui.scrollBy(0);
dump('after status/scrollBy(0)');
tui.scrollBy(-1);
dump('after scrollBy(-1)');
tui.scrollBy(-1);
dump('after scrollBy(-1) x2');
tui.scrollBy(1);
dump('after scrollBy(1)');
tui.screen.emit('keypress', null, { name: 'pageup', full: 'pageup' });
dump('after pageup key');
tui.screen.emit('keypress', null, { name: 'home', full: 'home' });
dump('after home key');
tui.screen.emit('keypress', null, { name: 'end', full: 'end' });
dump('after end key');
tui.close();
process.exit(0);
