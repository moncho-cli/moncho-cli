import test from 'node:test';
import assert from 'node:assert/strict';

import { createLineSplitter, parseStreamLine, readStream } from '../api/stream-reader.js';

/**
 * The streaming reader (`docs/runtime/provider-calls`).
 *
 * The reported bug: "sometimes the response prose from the model is missing space
 * characters … usually at the end of the prose". The streaming loop split **each read** on
 * `\n` and parsed the pieces, so a JSON payload cut in half by a read boundary lost its
 * first half — and its second half failed to parse on its own. A space is a delta, so a
 * lost delta is a missing space.
 *
 * These cases split a real SSE stream at every byte offset, which is the worst case a
 * transport can produce, and assert the reassembled text is byte-identical every time.
 */

/** A reader over a fixed list of string pieces, as the network would hand them over. */
function readerOf(pieces) {
  let index = 0;
  return {
    async read() {
      if (index >= pieces.length) return { done: true, value: undefined };
      const value = Buffer.from(pieces[index], 'utf-8');
      index += 1;
      return { done: false, value };
    },
  };
}

/** An SSE stream of content deltas, ending with the done marker. */
function sseStream(deltas, { marker = 'data: [DONE]' } = {}) {
  return deltas
    .map((content) => `data: ${JSON.stringify({ message: { content } })}\n\n`)
    .join('') + `${marker}\n`;
}

test('the splitter keeps a partial line between reads', () => {
  const splitter = createLineSplitter();
  // The first read ends mid-payload: nothing complete comes out.
  assert.deepEqual(splitter.push('data: {"message":{"content":"hel'), []);
  assert.equal(splitter.pending(), 'data: {"message":{"content":"hel');
  // The second read closes it and starts another.
  assert.deepEqual(splitter.push('lo"}}\n\ndata: {"mess'), ['data: {"message":{"content":"hello"}}', '']);
  assert.equal(splitter.pending(), 'data: {"mess');
});

test('the splitter releases a last line that never ended with a newline', () => {
  const splitter = createLineSplitter();
  splitter.push('data: {"message":{"content":"tail"}}');
  assert.deepEqual(splitter.flush(), ['data: {"message":{"content":"tail"}}']);
  assert.deepEqual(splitter.flush(), [], 'flushing twice releases nothing twice');
});

test('parseStreamLine() reads content, thinking, done and ignores framing', () => {
  assert.deepEqual(parseStreamLine('data: {"message":{"content":"hi"}}'), {
    done: false, content: 'hi', thinking: '',
  });
  // A thinking delta is not prose and must not reach the content.
  assert.deepEqual(parseStreamLine('data: {"message":{"content":"why","thinking":true}}'), {
    done: false, content: '', thinking: 'why',
  });
  assert.equal(parseStreamLine('data: [DONE]').done, true);
  assert.equal(parseStreamLine('[DONE]').done, true);
  // Framing, keep-alives and junk are not failures.
  assert.equal(parseStreamLine(''), null);
  assert.equal(parseStreamLine(': keep-alive'), null);
  assert.equal(parseStreamLine('data: {"partial":'), null);
});

test('readStream() reassembles the whole response from a stream split at every byte', async () => {
  const deltas = ['The response ', 'prose is ', 'missing ', 'spaces ', 'at the end ', 'of the prose.'];
  const stream = sseStream(deltas);
  const expected = deltas.join('');

  // Split at every single byte offset: the payload lands across a read boundary in all
  // the ways a transport can produce.
  for (let cut = 1; cut < stream.length; cut += 1) {
    const pieces = [stream.slice(0, cut), stream.slice(cut)];
    const seen = [];
    const text = await readStream(readerOf(pieces), { onContent: (chunk) => seen.push(chunk) });
    assert.equal(text, expected, `a read boundary at byte ${cut} lost a delta`);
    assert.equal(seen.join(''), expected, `the callbacks and the result disagree at byte ${cut}`);
  }
});

test('readStream() reports thinking without adding it to the content', async () => {
  const stream = [
    'data: {"message":{"content":"pondering","thinking":true}}\n\n',
    'data: {"message":{"content":"Answer"}}\n\n',
    'data: [DONE]\n',
  ].join('');
  const thinking = [];
  const content = [];
  const text = await readStream(readerOf([stream]), {
    onThinking: (chunk) => thinking.push(chunk),
    onContent: (chunk) => content.push(chunk),
  });
  assert.equal(text, 'Answer');
  assert.deepEqual(thinking, ['pondering']);
  assert.deepEqual(content, ['Answer']);
});

test('readStream() keeps a final delta that has no trailing newline', async () => {
  const text = await readStream(readerOf(['data: {"message":{"content":"no newline at the end"}}']));
  assert.equal(text, 'no newline at the end');
});

test('readStream() fires the done hook once and tolerates a silent stream', async () => {
  let done = 0;
  const text = await readStream(readerOf([sseStream(['one'])]), { onDone: () => { done += 1; } });
  assert.equal(text, 'one');
  assert.equal(done, 1);

  const empty = await readStream(readerOf([]));
  assert.equal(empty, '');
});

test('readStream() keeps a multi-byte character whole across a read boundary', async () => {
  const stream = sseStream(['héllo ', 'wörld']);
  const bytes = Buffer.from(stream, 'utf-8');
  // Cut in the middle of the two-byte "é" and again in the middle of "ö".
  const pieces = [bytes.subarray(0, 12), bytes.subarray(12, 40), bytes.subarray(40)];
  const text = await readStream({
    read: (() => {
      let index = 0;
      return async () => {
        if (index >= pieces.length) return { done: true, value: undefined };
        const value = pieces[index];
        index += 1;
        return { done: false, value };
      };
    })(),
  });
  assert.equal(text, 'héllo wörld');
});
