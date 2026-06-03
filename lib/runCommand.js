import { spawn } from 'node:child_process';

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { signal, ...spawnOptions } = options;
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnOptions
    });

    let stdout = '';
    let stderr = '';
    let aborted = false;

    const abortError =
      signal?.reason instanceof Error
        ? signal.reason
        : new Error(`${command} ${args.join(' ')} aborted`);

    const abortChild = () => {
      if (aborted) return;
      aborted = true;
      child.kill('SIGTERM');
      const forceKillTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 5000);
      forceKillTimer.unref?.();
    };

    if (signal) {
      if (signal.aborted) {
        abortChild();
      } else {
        signal.addEventListener('abort', abortChild, { once: true });
      }
    }

    child.stdout?.on('data', chunk => {
      const chunkText = chunk.toString();
      process.stdout.write(`[${command}] ${chunkText}`);
      stdout += chunkText;
    });

    child.stderr?.on('data', chunk => {
      const chunkText = chunk.toString();
      process.stderr.write(`[${command}] ${chunkText}`);
      stderr += chunkText;
    });

    child.on('error', reject);

    child.on('close', code => {
      signal?.removeEventListener?.('abort', abortChild);
      if (aborted) {
        reject(abortError);
        return;
      }
      if (code === 0) {
        resolve(stdout);
      } else {
        const error = new Error(`${command} ${args.join(' ')} exited with ${code}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}
