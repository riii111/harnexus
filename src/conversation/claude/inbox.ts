// Holds what Claude sent for the one reader that owns it, in order; a reader that stops takes back what it never read.
// settled waits until the reader has handled everything it was given, so the sender gives no more than the reader keeps up with.
export const createInbox = <T>() => {
  const queued: T[] = [];
  let waiting: ((item: T) => void) | null = null;
  let settlers: (() => void)[] = [];
  const settle = () => {
    const resolved = settlers;
    settlers = [];
    for (const resolve of resolved) resolve();
  };
  return {
    push: (item: T) => {
      const resolve = waiting;
      waiting = null;
      if (resolve === null) queued.push(item);
      else resolve(item);
    },
    take: () => {
      const item = queued.shift();
      if (item !== undefined) return Promise.resolve(item);
      settle();
      return new Promise<T>((resolve) => {
        waiting = resolve;
      });
    },
    settled: () =>
      queued.length === 0 && waiting !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            settlers.push(resolve);
          }),
    drain: () => {
      const left = queued.splice(0);
      settle();
      return left;
    },
  };
};

export type Inbox<T> = ReturnType<typeof createInbox<T>>;
