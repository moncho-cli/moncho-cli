/**
 * HTML stripped to the text a model can read.
 *
 * A `web_fetch` that hands back raw markup spends most of its budget on `<div>` soup: a
 * page whose prose is two kilobytes arrives as eighty kilobytes of attributes and
 * scripts. So the body is reduced to text here, and the reduction has three rules:
 *
 *  - **raw elements go entirely.** `script`, `style`, `noscript`, `template`, `svg`,
 *    `head` and comments hold no prose a reader wants, and a script's body is the one part
 *    of a page that must never be mistaken for content.
 *  - **structure becomes whitespace, not concatenation.** A block element ends a line
 *    (`</p>`, `<br>`, `<li>`), so `</h1><p>text` does not arrive as `Titletext`. Whatever
 *    the layout was, the text keeps its shape.
 *  - **entities are decoded once.** `&amp;lt;` is the text `&lt;`, and `&amp;` is `&`; the
 *    named table covers the entities that actually appear in pages, and an unknown or
 *    malformed `&…;` stays exactly as it was written.
 *
 * Pure string work — no `fs`, no network, no terminal — so the whole rule is unit tested on
 * plain strings (`tests/web-fetch.test.js`).
 */

/** The tag name of a start/end tag, lowercased, or `null` when this is not one. */
function tagName(match) {
  const name = String(match ?? '').trim().toLowerCase();
  const bare = name.match(/^\/?\s*([a-z][a-z0-9:-]*)/);
  return bare ? bare[1] : null;
}

/** True for an element whose whole contents are dropped, opening and closing tag alike. */
export function isRawElement(name) {
  return ['script', 'style', 'noscript', 'template', 'svg', 'head', 'title'].includes(
    String(name ?? '').toLowerCase(),
  );
}

/**
 * The elements that end a **paragraph**. Two tags in a row therefore leave one blank line,
 * which is what keeps a heading apart from the prose under it.
 */
const PARAGRAPH_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);

/**
 * The elements that end a **line** only: the members of a list or a table row, and `<br>`
 * — the one void element whose whole meaning is a break. Items of one list must not be
 * separated from each other the way paragraphs are.
 */
const LINE_ELEMENTS = new Set(['br', 'dd', 'dt', 'li', 'td', 'tfoot', 'th', 'thead', 'tbody', 'tr']);

/** The line elements that never carry a closing tag, and so break on opening. */
const VOID_LINE_ELEMENTS = new Set(['br']);

/**
 * The break one tag boundary leaves: a blank line for a paragraph element, a newline for a
 * line element, a space for anything inline.
 *
 * A line element breaks **once**, and closing is the side that does it: `<li>one</li>`
 * would otherwise emit a break twice and turn a list into a column of paragraphs. `<br>` is
 * in the same set but never closes, so it is the one open tag that carries its own break.
 *
 * An inline element breaks **nothing**: in HTML `a<b>bold</b>.` means `abold.`, and the
 * space a naive reducer inserts is the one that turns `bold.` into `bold .`.
 */
export function breakFor(name, { closing = false, selfClosing = false } = {}) {
  if (PARAGRAPH_ELEMENTS.has(name)) return '\n\n';
  if (LINE_ELEMENTS.has(name)) return closing || selfClosing ? '\n' : '';
  return '';
}

/** One named entity reference, or `null`. */
function namedEntity(name) {
  const table = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·',
    deg: '°', plusmn: '±', times: '×', divide: '÷', frac12: '½',
    laquo: '«', raquo: '»', sect: '§', para: '¶', dagger: '†', euro: '€',
    pound: '£', yen: '¥', cent: '¢', permil: '‰', prime: '′', Prime: '″',
    larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', infin: '∞',
    ne: '≠', le: '≤', ge: '≥', minus: '−', sum: '∑', prod: '∏', radic: '√',
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π', sigma: 'σ', omega: 'ω',
    // The accented Latin letters real pages use constantly: without them a page reads
    // "caf&eacute;" where it said "café".
    agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ',
    ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
    igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ',
    ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø',
    ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ',
    Agrave: 'À', Aacute: 'Á', Auml: 'Ä', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É',
    Ouml: 'Ö', Uuml: 'Ü', Ntilde: 'Ñ', szlig: 'ß',
  };
  return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : null;
}

/**
 * Decode one entity reference: `&#38;`, `&#x26;` and the named table. An unknown name, a
 * number outside Unicode, or a missing semicolon is left **as written** — a page showing
 * `&foo;` meant to show `&foo;`.
 */
export function decodeEntity(body) {
  const raw = String(body ?? '');
  const code = raw.match(/^#(\d+)$/);
  if (code) {
    const point = Number(code[1]);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : `&${raw};`;
  }
  const hex = raw.match(/^#[xX]([0-9a-fA-F]+)$/);
  if (hex) {
    const point = Number.parseInt(hex[1], 16);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : `&${raw};`;
  }
  const named = namedEntity(raw);
  return named === null ? `&${raw};` : named;
}

/** Every entity reference in a text, decoded in one pass. */
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#(?:[0-9]+|[xX][0-9a-fA-F]+)|[A-Za-z][A-Za-z0-9]*);/g, (whole, body) => decodeEntity(body));
}

/** Collapse runs of spaces and tabs, and drop the whitespace around each line. */
export function normalizeWhitespace(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Reduce HTML to readable text: raw elements removed, block elements turned into line
 * breaks, inline tags dropped, entities decoded, whitespace normalised.
 *
 * The order matters and is the whole trick — raw elements are stripped *before* entities
 * are decoded, so a script containing `&lt;/script&gt;` cannot smuggle itself back into
 * the output as markup, and `<` in the result is text rather than a tag.
 */
export function htmlToText(html) {
  let text = String(html ?? '');

  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');

  // Raw elements: opening tag through its matching closing tag, case-insensitively, with
  // the unterminated-tail case (a truncated document) handled by the `$` alternative.
  text = text.replace(/<(script|style|noscript|template|svg|head|title)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');

  // A tag boundary becomes a break when the element is structural, and **nothing** when it
  // is inline: `<b>bold</b>` must arrive as the word it is, not as ` bold `.
  text = text.replace(/<[^>]*>/g, (tag) => {
    const name = tagName(tag.replace(/^<+/, ''));
    if (!name) return '';
    return breakFor(name, {
      closing: /^<\s*\//.test(tag),
      selfClosing: VOID_LINE_ELEMENTS.has(name),
    });
  });

  return normalizeWhitespace(decodeEntities(text));
}

/** True when a content type is one this reducer understands. */
export function isHtmlType(contentType) {
  return /text\/html|application\/xhtml\+xml/i.test(String(contentType ?? ''));
}
