type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/** Runs at most `max` tasks at once; queued tasks start in call order. */
function createLimiter(max: number): Limiter {
  let active = 0;
  const queue: (() => void)[] = [];

  /** Hands the slot straight to the next waiter, so no other call can take it in between. */
  function release(): void {
    const next = queue.shift();
    if (next === undefined) {
      active -= 1;
      return;
    }
    next();
  }

  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      release();
    }
  };
}

export { createLimiter };
export type { Limiter };
