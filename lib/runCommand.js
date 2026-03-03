import { spawn } from 'node:child_process';

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });

    let stdout = '';

    child.stdout?.on('data', chunk => {
      const chunkText = chunk.toString();
      process.stdout.write(`[${command}] ${chunkText}`);
      stdout += chunkText;
    });

    child.stderr?.on('data', chunk => {
      process.stderr.write(`[${command}] ${chunk.toString()}`);
    });

    child.on('error', reject);

    child.on('close', code => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
      }
    });
  });
}
