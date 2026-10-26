import { runCommand } from './runCommand.js';

export function readinessConcurrency(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 8 ? parsed : 4;
}

// One FIFO shared by every lab in this worker process. Only an individual probe
// holds a slot; a guest's retry backoff never prevents another guest from probing.
export function createReadinessLimiter(limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid readiness limit');
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < limit && queue.length) {
      const entry = queue.shift();
      entry.signal?.removeEventListener('abort', entry.abort);
      active++;
      Promise.resolve().then(() => {
        entry.signal?.throwIfAborted();
        return entry.operation();
      }).then(entry.resolve, entry.reject).finally(() => {
        active--;
        drain();
      });
    }
  };
  return (operation, signal) => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const entry = { operation, signal, resolve, reject };
    entry.abort = () => {
      const index = queue.indexOf(entry);
      if (index !== -1) queue.splice(index, 1);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', entry.abort, { once: true });
    queue.push(entry);
    drain();
  });
}

const limit = createReadinessLimiter(readinessConcurrency(process.env.GUEST_READINESS_CONCURRENCY));
export const runReadinessCommand = (command, args, options = {}) =>
  limit(() => runCommand(command, args, options), options.signal);
