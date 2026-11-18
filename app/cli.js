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
    close() {
      rl.close();
    }
  };
}
