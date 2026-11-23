import { estimateMessageTokens } from './tokens.js';

/**
 * The **provenance of each chunk**: the Moncho build that wrote it and what it cost,
 * kept *beside* the chunks and never on them (`docs/runtime/chunk-provenance`).
 *
 * A change to the prompt, the tools, the collapse or the compaction is a claim about
 * behaviour, and nothing in the record today can tell a change that helped from one that
 * hurt: the conversation is stored, but not *what produced it* or *what it weighed*.
 * This module owns the per-chunk answer to both, so the data accumulates from now on and
 * a later comparison has something to compare.
 *
 *     agent/sessions/<id>/conversation.json   every chunk, and beside each one:
 *                                             { moncho: "0.25.0", tokens: 137 }
 *
 * **The version is Moncho's own, and the field says so.** That is not a cosmetic naming
 * choice. In the maintainer flow the agent runs *on* this repository, so "the version"
 * is unambiguous; in the user flow it runs *inside someone else's checkout*, which has a
 * `package.json#version` of its own. A field called `app` would read as that project's
 * version, and the obvious future "improvement" — read the version next to the working
 * directory — would silently fill the record with a number that has nothing to do with
 * the build that produced the chunk. `moncho` cannot be read that way, and the value is
 * resolved module-relative (`app/brand.js` imports `../package.json`), never from the
 * cwd. `tests/chunk-meta.test.js` proves both halves.
 *
 * Two more rules decide the shape, and the second is the decisive one:
 *
 *  - **a parallel array, never a field on the chunk.** A chunk is what the provider is
 *    sent verbatim (`app/context-window.js#request`), and a strict OpenAI-compatible
 *    endpoint can reject an unknown key — the same reason the append times
 *    (`utils/chunk-stamps.js`) and the item attributions live beside the chunks.
 *  - **the window and the journal hold the *same objects*.** `add()` pushes one object
 *    into both, so a bookkeeping field would not merely be sent: it would be sent *and*
 *    written to the record, changing what a stored conversation is. A parallel array
 *    cannot leak that way.
 *
 * Aligned with the **journal**, not the window: the journal is append-only and a
 * compaction never rebuilds it, so an entry is written once and never re-aligned — which
 * is also why this is far simpler than `utils/chunk-stamps.js#alignStamps`, whose whole
 * job is following chunks through a rewrite the journal never suffers.
 *
 * Pure: no clock, no filesystem, and the version is handed in, so every rule is provable
 * on arrays.
 */

/** The stored shape of an entry with nothing known about it. */
export const NO_META = null;

/**
 * The provenance of one chunk.
 *
 * `tokens` is the **atomic** estimate for that chunk alone (`estimateMessageTokens`), not
 * a running total: a total can be recomputed from the parts, while the parts cannot be
 * recovered from a total. `moncho` is **Moncho's** version — never the version of the
 * project the agent happens to be working in — so a record spanning an upgrade says which
 * build produced which chunk.
 *
 * @param {any} chunk the chunk being described
 * @param {object} [options]
 * @param {string} [options.moncho] Moncho's version, or `null` when it is not known
 * @param {Function} [options.estimate] the token estimator, injected so the rule is testable
 * @returns {{moncho: string|null, tokens: number}}
 */
export function buildChunkMeta(chunk, { moncho = null, estimate = estimateMessageTokens } = {}) {
  const version = typeof moncho === 'string' && moncho.trim() !== '' ? moncho.trim() : null;
  let tokens = 0;
  try {
    tokens = Number(estimate(chunk)) || 0;
  } catch {
    // An entry that cannot be estimated is still an entry: the version is the half that
    // cannot be recomputed later, so it is never thrown away for the half that can.
    tokens = 0;
  }
  return { moncho: version, tokens: Math.max(0, Math.round(tokens)) };
}

/** `count` entries for one batch of chunks, described the same way. */
export function metaRepeated(chunks, options = {}) {
  const list = Array.isArray(chunks) ? chunks : [chunks];
  return list.map((chunk) => buildChunkMeta(chunk, options));
}

/**
 * True when `value` can be a stored entry.
 *
 * A record written before the field existed, or one carrying junk, yields `NO_META` for
 * that row rather than a wrong claim — the rule the marks follow.
 */
export function isChunkMeta(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const versionOk = value.moncho === null
    || (typeof value.moncho === 'string' && value.moncho.trim() !== '');
  return versionOk && Number.isFinite(Number(value.tokens));
}

/**
 * Force a meta list to exactly `length` entries: short lists are padded with `null`,
 * long ones trimmed, and every entry that is not a real entry becomes `null`.
 *
 * This is the one guard that keeps a hand-edited or older file from shifting provenance
 * onto the wrong rows.
 *
 * @param {any[]} meta
 * @param {number} length the chunk count the entries must match
 * @returns {(({moncho: string|null, tokens: number})|null)[]}
 */
export function normalizeMeta(meta = [], length = 0) {
  const size = Math.max(0, Number(length) || 0);
  const list = Array.isArray(meta) ? meta : [];
  return Array.from({ length: size }, (_, index) => {
    const value = list[index];
    if (!isChunkMeta(value)) return NO_META;
    return {
      moncho: typeof value.moncho === 'string' && value.moncho.trim() !== '' ? value.moncho.trim() : null,
      tokens: Math.max(0, Math.round(Number(value.tokens) || 0)),
    };
  });
}

/**
 * The provenance a list of entries holds, summarised for a reader.
 *
 * This is the shape a later investigation actually wants: which builds are represented,
 * how many chunks each wrote, and what they weighed — so "did 0.25.0 cost more per chunk
 * than 0.24.0" is a question the file can answer without loading the chunks.
 */
export function summarizeMeta(meta = []) {
  const byVersion = new Map();
  let chunks = 0;
  let tokens = 0;
  let unknown = 0;
  for (const entry of Array.isArray(meta) ? meta : []) {
    if (!isChunkMeta(entry)) {
      unknown += 1;
      continue;
    }
    const weight = Math.max(0, Math.round(Number(entry.tokens) || 0));
    chunks += 1;
    tokens += weight;
    const key = entry.moncho === null ? null : String(entry.moncho);
    const bucket = byVersion.get(key) || { moncho: key, chunks: 0, tokens: 0 };
    bucket.chunks += 1;
    bucket.tokens += weight;
    byVersion.set(key, bucket);
  }
  return {
    chunks,
    tokens,
    unknown,
    // Stable order, so two summaries of the same file are comparable by eye and by diff.
    versions: [...byVersion.values()].sort((a, b) => String(a.moncho).localeCompare(String(b.moncho))),
  };
}
