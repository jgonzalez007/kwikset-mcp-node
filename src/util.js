// Small shared helper: races a promise against a timeout so a stuck
// network call fails fast with a clear message instead of hanging until
// whatever's waiting on it (e.g. the MCP host, which gives up after 60s)
// times out with a generic, unhelpful error.

export class TimeoutError extends Error {}

export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
