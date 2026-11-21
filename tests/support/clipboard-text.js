/**
 * Decode the payload out of an OSC 52 sequence, so a copy can be asserted on its *text*
 * rather than on its bytes.
 *
 * Shared by the clipboard cases (`tests/clipboard-selection*.test.js`): the sequence is the
 * contract with the terminal, so every case that checks "what went to the clipboard?" goes
 * through here instead of re-deriving the envelope per file.
 */
export function clipboardText(sequence) {
  const match = /\]52;([^;]*);([^\x07]*)\x07/.exec(String(sequence));
  return match ? Buffer.from(match[2], 'base64').toString('utf8') : null;
}
