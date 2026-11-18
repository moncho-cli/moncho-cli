import readline from 'readline';
import fs from 'fs';
import { RESPONSE_FILE } from '../config/constants.js';

export function createCLI() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

  return {
    rl,
    question,
    saveResponse(content) {
      fs.writeFileSync(RESPONSE_FILE, content);
    },
    close() {
      rl.close();
    }
  };
}
