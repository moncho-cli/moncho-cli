import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  ALLOWED_PROTOCOLS, WebFetchError, validateFetchUrl, charsetFromBody, decodeBody,
  readBounded, fetchUrl, windowBody, normalizeCharset, isSupportedCharset, timeoutSignal,
} from '../utils/web-fetch.js';
import {
  decodeEntity, decodeEntities, htmlToText, isRawElement, breakFor, normalizeWhitespace,
} from '../utils/html-text.js';
import { execute as webFetchExecute } from '../tools/web_fetch.js';
import { READ_ONLY_TOOLS, refusalForMode } from '../app/mode-policy.js';
import { toolFamily, toolColorFor } from '../app/tool-palette.js';
import { getCapture, clearCaptures } from '../utils/capture-store.js';
import { execute as readCaptureExecute } from '../tools/read_capture.js';

/**
 * Proof for `web_fetch` (docs/agent/web-fetch): the pure bounds and the HTML reducer, the
 * tool end to end against a **local** http server (the suite needs no network), and the
 * registrations that decide where a fetch may run and how it is painted.
 */

const server = http.createServer((req, res) => {
  const route = req.url.split('?')[0];
  const routes = {
    '/page.html': () => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Title</h1><p>Prose &amp; <b>bold</b>.</p><ul><li>one</li><li>two</li></ul></body></html>');
    },
    '/latin.html': () => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(Buffer.from('<html><head><meta charset="iso-8859-1"></head><body>caf\u00e9</body></html>', 'latin1'));
    },
    '/data.json': () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, items: [1, 2, 3] }));
    },
    '/missing': () => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nothing here');
    },
    '/hop1': () => {
      res.writeHead(302, { location: '/page.html' });
      res.end();
    },
    '/loop': () => {
      res.writeHead(302, { location: '/loop' });
      res.end();
    },
    '/big': () => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n'));
    },
    '/scroller': () => {
      // A body longer than any sensible cap: the reader must be cancelled mid-stream.
      res.writeHead(200, { 'content-type': 'text/plain' });
      const chunk = 'y'.repeat(64 * 1024);
      for (let i = 0; i < 40; i += 1) res.write(chunk);
      res.end();
    },
  };
  const handler = routes[route];
  if (handler) return handler();
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('plain');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

/** The YAML header fields of a document, as a plain object. */
function headerOf(document) {
  const [head] = document.split('\n---\n');
  const fields = {};
  for (const line of head.split('\n')) {
    const at = line.indexOf(': ');
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 2).replace(/^"|"$/g, '');
  }
  return fields;
}

/** The payload of a document (everything after the `---` delimiter). */
const payloadOf = (document) => document.split('\n---\n').slice(1).join('\n---\n');

// ---------------------------------------------------------------------------
// the pure bounds
// ---------------------------------------------------------------------------

test('validateFetchUrl accepts http and https and refuses every other scheme', () => {
  assert.equal(validateFetchUrl('https://example.com/a?b=1').hostname, 'example.com');
  assert.equal(validateFetchUrl('http://example.com').protocol, 'http:');
  assert.deepEqual(ALLOWED_PROTOCOLS, ['http:', 'https:']);

  for (const bad of ['file:///etc/passwd', 'data:text/plain,hi', 'ftp://example.com']) {
    assert.throws(() => validateFetchUrl(bad), (error) => {
      assert.equal(error.code, 'UNSUPPORTED_PROTOCOL');
      assert.match(error.guidance, /http\(s\)/);
      return true;
    });
  }
  // A bare host is the mistake a caller actually makes, so it says how to fix it.
  assert.throws(() => validateFetchUrl('example.com/page'), (error) => {
    assert.equal(error.code, 'INVALID_URL');
    assert.match(error.guidance, /Include the scheme/);
    return true;
  });
  assert.throws(() => validateFetchUrl('   '), WebFetchError);
});

test('normalizeCharset and isSupportedCharset recognise the real spellings', () => {
  assert.equal(normalizeCharset('UTF8'), 'utf-8');
  assert.equal(normalizeCharset('latin1'), 'windows-1252');
  assert.equal(isSupportedCharset('utf-8'), true);
  assert.equal(isSupportedCharset('made-up-9'), false);
});

test('readBounded streams a body, cuts it at the cap and cancels the reader', async () => {
  const response = await fetch(`${base}/scroller`);
  const bounded = await readBounded(response, 4096);

  assert.equal(bounded.bytes.length, 4096, 'the cap is the whole point');
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.totalBytes > 4096, 'the server sent more than we kept');

  // A body inside the cap comes back whole and is not called truncated.
  const small = await readBounded(await fetch(`${base}/data.json`), 4096);
  assert.equal(small.truncated, false);
  assert.ok(small.bytes.length < 4096);
});

test('fetchUrl follows redirects and refuses a loop and a downgrade', async () => {
  const followed = await fetchUrl(`${base}/hop1`);
  assert.equal(followed.response.status, 200);
  assert.equal(followed.hops, 1);
  assert.match(followed.finalUrl, /\/page\.html$/);

  await assert.rejects(() => fetchUrl(`${base}/loop`, { maxRedirects: 2 }), (error) => {
    assert.equal(error.code, 'TOO_MANY_REDIRECTS');
    return true;
  });

  // https is never downgraded mid-chain, whatever the server asks for.
  const fetchImpl = async (url) => {
    if (String(url).startsWith('https://')) {
      return new Response(null, { status: 302, headers: { location: 'http://insecure.example/' } });
    }
    return new Response('landed', { status: 200, headers: { 'content-type': 'text/plain' } });
  };
  await assert.rejects(() => fetchUrl('https://secure.example/', { fetchImpl }), (error) => {
    assert.equal(error.code, 'REDIRECT_DOWNGRADE');
    return true;
  });
});

test('windowBody shows a body from the top and reports what it cut', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `l${i + 1}`).join('\n');

  const all = windowBody('a\nb', 10);
  assert.deepEqual({ shown: all.shown, truncated: all.truncated, mode: all.mode }, { shown: 2, truncated: false, mode: 'all' });

  // A document is read from its opening, unlike a command's default tail.
  const clipped = windowBody(lines, 5);
  assert.equal(clipped.mode, 'head');
  assert.equal(clipped.shown, 5);
  assert.equal(clipped.total, 50);
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.text, 'l1\nl2\nl3\nl4\nl5');
});

test('timeoutSignal is a signal, and it expires', async () => {
  const signal = timeoutSignal(5);
  assert.equal(typeof signal.aborted, 'boolean');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(signal.aborted, true, 'a timeout that never fires is not a timeout');
  assert.equal(timeoutSignal(0).aborted, false, 'a nonsense budget falls back, and does not fire early');
});

// ---------------------------------------------------------------------------
// the HTML reducer
// ---------------------------------------------------------------------------

test('decodeEntity decodes what it knows and leaves the rest exactly as written', () => {
  assert.equal(decodeEntity('amp'), '&');
  assert.equal(decodeEntity('#38'), '&');
  assert.equal(decodeEntity('#x26'), '&');
  assert.equal(decodeEntity('mdash'), '—');
  // A page showing `&foo;` meant to show `&foo;`.
  assert.equal(decodeEntity('nope'), '&nope;');
  assert.equal(decodeEntity('#0'), '&#0;');
  assert.equal(decodeEntity('#1114112'), '&#1114112;');
  assert.equal(decodeEntities('&amp;lt; &#xZZ; &amp;'), '&lt; &#xZZ; &');
});

test('isRawElement and breakFor answer the two structural questions', () => {
  for (const name of ['script', 'style', 'head', 'svg', 'title', 'noscript', 'template']) {
    assert.equal(isRawElement(name), true, name);
  }
  assert.equal(isRawElement('p'), false);

  assert.equal(breakFor('p', { closing: true }), '\n\n');
  assert.equal(breakFor('li', { closing: true }), '\n');
  assert.equal(breakFor('li'), '', 'a list item breaks once, at its close');
  assert.equal(breakFor('br', { selfClosing: true }), '\n');
  assert.equal(breakFor('b', { closing: true }), '', 'an inline tag introduces nothing');
});

test('htmlToText drops raw elements, keeps block structure and invents no space', () => {
  const html = '<html><head><style>p{color:red}</style><script>var a = "</p>";</script></head>'
    + '<body><!-- c --><h1>Title</h1><p>Prose &amp; <b>bold</b>.</p><ul><li>one</li><li>two</li></ul>'
    + '<div>caf&eacute;<!--x--></div></body></html>';
  const text = htmlToText(html);

  assert.doesNotMatch(text, /color:red|var a|<!--/, 'no script, style or comment survives');
  assert.match(text, /^Title\n\nProse & bold\./, 'a block ends a paragraph, an inline tag nothing');
  assert.match(text, /\none\ntwo\n/, 'list items are one line each');
  assert.match(text, /café/, 'an accented entity is decoded');
  assert.doesNotMatch(text, /<[a-z]/i, 'no markup is left behind');
  // A script cannot smuggle markup back in: the `</p>` it held left with it.
  assert.doesNotMatch(text, /<\/p>/);
});

test('normalizeWhitespace collapses runs and keeps line structure', () => {
  assert.equal(normalizeWhitespace('  a   b \n\n\n\n c  '), 'a b\n\nc');
  assert.equal(normalizeWhitespace('a\r\nb'), 'a\nb');
  assert.equal(normalizeWhitespace('\n\t\n'), '');
});

test('charsetFromBody and decodeBody read the declaration, and an unknown label falls back with a note', () => {
  assert.equal(charsetFromBody('<meta charset="ISO-8859-1">'), 'iso-8859-1');
  assert.equal(charsetFromBody('<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">'), 'windows-1252');
  assert.equal(charsetFromBody('<p>nothing declared</p>'), null);

  // The content type wins; the document's own meta is the fallback.
  const utf8 = decodeBody(new TextEncoder().encode('<p>café</p>'), { contentType: 'text/html', head: '<meta charset="utf-8">' });
  assert.equal(utf8.charset, 'utf-8');
  assert.equal(utf8.note, null);
  assert.match(utf8.text, /café/);

  const latin = decodeBody(Buffer.from([0x63, 0x61, 0x66, 0xe9]), { contentType: 'text/html' , head: '<meta charset="iso-8859-1">' });
  assert.equal(latin.charset, 'windows-1252');
  assert.equal(latin.text, 'café');

  // Mangled text beats no text: an unknown label falls back and says so.
  const unknown = decodeBody(Buffer.from('a'), { contentType: 'text/html; charset=made-up-9' });
  assert.equal(unknown.charset, 'utf-8');
  assert.match(unknown.note, /made-up-9/);
});

// ---------------------------------------------------------------------------
// the tool, against a local server
// ---------------------------------------------------------------------------

test('web_fetch answers an HTML page as a document of reduced text', async () => {
  const document = await webFetchExecute({ url: `${base}/page.html`, intent: 'read the page' });
  const header = headerOf(document);

  assert.equal(header.status, 'success');
  assert.equal(header.http_status, '200');
  assert.match(header.content_type, /text\/html/);
  assert.equal(header.mode, 'all');
  assert.match(payloadOf(document), /^Title\n\nProse & bold\./, 'the body is the readable text');
  assert.doesNotMatch(payloadOf(document), /alert\(1\)/, 'the script is gone');
});

test('web_fetch passes JSON through and reports an HTTP status as a document', async () => {
  const json = await webFetchExecute({ url: `${base}/data.json`, intent: 'read the api' });
  assert.equal(JSON.parse(payloadOf(json)).ok, true, 'an API answer is already text');

  // A 404 is news, not a failure: the server answered.
  const missing = await webFetchExecute({ url: `${base}/missing`, intent: 'read a missing page' });
  assert.equal(headerOf(missing).http_status, '404');
  assert.equal(headerOf(missing).status, 'success');
  assert.match(payloadOf(missing), /nothing here/);

  // A redirect chain reports the final url, and the one it was asked for.
  const followed = await webFetchExecute({ url: `${base}/hop1`, intent: 'follow the redirect' });
  assert.match(headerOf(followed).final_url, /\/page\.html$/);
  assert.match(headerOf(followed).url, /\/hop1$/);
});

test('web_fetch decodes the charset the document declares', async () => {
  const document = await webFetchExecute({ url: `${base}/latin.html`, intent: 'read an accented page' });
  assert.match(headerOf(document).charset, /windows-1252|iso-8859-1/);
  assert.match(payloadOf(document), /café/);
});

test('web_fetch hands a long body to the capture store for read_capture', async () => {
  clearCaptures();
  const document = await webFetchExecute({ url: `${base}/big`, intent: 'read a long page', maxLines: 5 });
  const header = headerOf(document);

  assert.equal(header.mode, 'head');
  assert.equal(header.shown, '5');
  assert.equal(header.lines, '400');
  assert.equal(payloadOf(document), 'line 1\nline 2\nline 3\nline 4\nline 5');
  const handle = Number(header.capture);
  assert.ok(handle > 0, 'the rest is not thrown away');
  assert.ok(getCapture(handle), 'and the handle really resolves');

  // One new tool, no second paging grammar: read_capture reads it.
  const page = await readCaptureExecute({ capture: handle, pattern: 'line 400', intent: 'scan the tail' });
  assert.match(page, /line 400/);
});

test('web_fetch keeps the rest of a body the download cut, not only one the window cut', async () => {
  clearCaptures();
  // A cut body that is a single long line: nothing is windowed, yet the rest is real.
  const document = await webFetchExecute({ url: `${base}/scroller`, intent: 'read a big body', maxBytes: 2048 });
  const header = headerOf(document);

  assert.equal(header.truncated, 'true');
  assert.equal(header.bytes, '2048');
  assert.ok(Number(header.total_bytes) > 2048);
  assert.ok(Number(header.capture) > 0, 'a download that was cut still hands its text over');
});

test('web_fetch refuses a bad URL, an unsupported scheme and a dead host with a stable code', async () => {
  const badUrl = JSON.parse(await webFetchExecute({ url: 'example.com/page', intent: 'wrong' }));
  assert.equal(badUrl.status, 'error');
  assert.equal(badUrl.code, 'INVALID_URL');
  assert.match(badUrl.guidance, /Include the scheme/);

  const scheme = JSON.parse(await webFetchExecute({ url: 'file:///etc/passwd', intent: 'read a local file' }));
  assert.equal(scheme.code, 'UNSUPPORTED_PROTOCOL');

  // A refused connection is a failure *during* the request: FETCH_FAILED, with guidance.
  const dead = JSON.parse(await webFetchExecute({ url: 'http://127.0.0.1:1/nothing', intent: 'reach a dead host', timeoutMs: 2000 }));
  assert.equal(dead.status, 'error');
  assert.equal(dead.code, 'FETCH_FAILED');
  assert.ok(dead.guidance);

  // A redirect loop is refused rather than followed forever.
  const loop = JSON.parse(await webFetchExecute({ url: `${base}/loop`, intent: 'follow a loop', maxRedirects: 2 }));
  assert.equal(loop.code, 'TOO_MANY_REDIRECTS');
});

// ---------------------------------------------------------------------------
// where a fetch may run, and how it is painted
// ---------------------------------------------------------------------------

test('web_fetch is a read-only tool in the read family', () => {
  assert.ok(READ_ONLY_TOOLS.includes('web_fetch'), 'a fetch reads and writes nothing');
  assert.equal(refusalForMode('chat', { name: 'web_fetch', args: {} }), null, 'Chat may fetch');
  assert.equal(refusalForMode('design', { name: 'web_fetch', args: {} }), null, 'Design may fetch');
  assert.equal(toolFamily('web_fetch'), 'read');
  assert.equal(toolColorFor('web_fetch'), 'bright-cyan');
});
