import readline from 'readline';

export function createCLI() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  // The pending resolver is kept so exit() can settle an armed question: the host
  // loop treats the 'exit' sentinel exactly like the user typing it.
  let pending = null;
  const ask = (prompt) => new Promise((resolve) => {
    pending = resolve;
    rl.question(prompt, (answer) => {
      pending = null;
      resolve(answer);
    });
  });

  /** Settle an armed question with the 'exit' sentinel. False when none is armed. */
  const exit = () => {
    if (!pending) return false;
    const resolve = pending;
    pending = null;
    resolve('exit');
    return true;
  };

  return {
    rl,
    question: ask,
    exit,
    /**
     * Pick one of `labels` by number: the line-CLI counterpart of the TUI modal.
     *
     * Resolves with the index of the choice, or null when the answer is empty, out
     * of range, or `q` — the same contract the command registry expects, so a
     * command does not care which front end asked.
     */
    async choose(labels = [], { title = 'Select' } = {}) {
      const items = [...labels];
      if (items.length === 0) return null;
      console.log(`\n${title}:`);
      items.forEach((label, index) => console.log(`  ${index + 1}) ${label}`));
      const answer = String(await ask('Number (empty or q to cancel): ')).trim();
      const lowered = answer.toLowerCase();
      if (!answer || lowered === 'q' || lowered === 'exit') return null;
      const index = Number.parseInt(answer, 10) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= items.length) return null;
      return index;
    },
    close() {
      rl.close();
    }
  };
}
