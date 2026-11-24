/**
 * Reading a prompt from stdin (`--exec -`; docs/runtime/run-flags).
 *
 * Kept apart from `utils/run-flags.js` on purpose: that module is pure and terminal-free, and
 * this one touches a real stream. The stream is injected so the whole contract is still
 * provable without a terminal (`tests/run-flags.test.js`).
 *
 * Two facts shape it.
 *
 * **A terminal is refused, not read.** A pipe ends; a tty does not. `readFileSync(0)` on a
 * terminal blocks until the user types Ctrl+D, which for a one-shot run is a hang: the
 * process sits there with no prompt on screen explaining what it is waiting for. So a tty is
 * refused up front, with a message that names the mistake — the caller meant to pipe.
 *
 * **The read is asynchronous.** `readFileSync(0)` stops the event loop, so nothing else in
 * the process can run while it waits. Reading the stream instead keeps the process live, and
 * the answer is awaited once at startup, before the session is wired — which is where a bad
 * stdin belongs, beside the other argument errors, rather than in the middle of a turn.
 */

/**
 * Read a prompt from a stream.
 *
 * @param {object} [options]
 * @param {NodeJS.ReadableStream} [options.stdin] the stream to read (default `process.stdin`)
 * @param {boolean} [options.isTTY] whether that stream is a terminal (default: ask it)
 * @returns {Promise<string>} everything written, decoded as UTF-8, verbatim
 * @throws {Error} when the stream is a terminal, which would never end
 */
export async function readStdinPrompt({ stdin = process.stdin, isTTY } = {}) {
  const terminal = isTTY === undefined ? Boolean(stdin?.isTTY) : Boolean(isTTY);
  if (terminal) {
    throw new Error(
      'the prompt cannot be read from a terminal: nothing would ever end it. '
      + 'Pipe it in instead, or name it with --prompt or a file',
    );
  }
  if (!stdin?.on) return '';

  const chunks = [];
  // `for await` over the stream is what releases every chunk until EOF, and it drains the
  // buffered data a small pipe may have delivered before this ran.
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}