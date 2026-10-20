// A yes/no question on the terminal. Goes to stderr so `--json` stdout stays
// a single document; a non-interactive stdin answers "no".

import readline from 'node:readline';

export async function confirm(question: string, io: { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream } = {}): Promise<boolean> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stderr;
  if (!input.isTTY) return false;
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export const isInteractive = () => !!process.stdin.isTTY;
