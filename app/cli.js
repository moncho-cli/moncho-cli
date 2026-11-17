import readline from 'readline';
import process from 'process';
import { RESPONSE_FILE } from '../config/constants.js';
import fs from 'fs';

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
