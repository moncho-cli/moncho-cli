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
const painted = [];
output.on('data', (c) => painted.push(c.toString()));

const screen = blessed.screen({ input, output, smartCSR: true, warnings: false });
const log = blessed.log({ top: 0, bottom: 4, left: 0, right: 0, label: ' Conversation ', scrollable: true, alwaysScroll: true, tags: false });
const status = blessed.box({ bottom: 3, height: 1, content: 'Ready', tags: false });
const box = blessed.textbox({ bottom: 0, height: 3, label: ' > ', inputOnFocus: true, tags: false });
screen.append(log);
screen.append(status);
screen.append(box);
screen.render();

console.log('after render, painted len =', painted.join('').length);
console.log('has program.flush:', typeof screen.program.flush);
console.log('useBuffer:', screen.program.useBuffer);
console.log('_buf len:', (screen.program._buf || '').length);
screen.program.flush();
console.log('after flush, painted len =', painted.join('').length);
console.log('after flush _buf len:', (screen.program._buf || '').length);
console.log('has Conversation:', /Conversation/.test(painted.join('')));
console.log('has Ready:', /Ready/.test(painted.join('')));

setImmediate(() => {
  console.log('after tick, painted len =', painted.join('').length);
  process.exit(0);
});
