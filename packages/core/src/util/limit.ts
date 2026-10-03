type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/** Runs at most `max` tasks at once; queued tasks start in call order. */
function createLimiter(max: number): Limiter {
  let active = 0;
  const queue: (() => void)[] = [];

  function release(): void {
    active -= 1;
    queue.shift()?.();
  }

  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    }
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

export { createLimiter };
export type { Limiter };
