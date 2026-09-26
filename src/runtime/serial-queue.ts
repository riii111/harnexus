type SerialQueue = {
  run: <T>(key: string, task: () => Promise<T>) => Promise<T>;
};

// Tasks with the same key run one at a time in arrival order; different keys run concurrently.
export const createSerialQueue = (): SerialQueue => {
  const tails = new Map<string, Promise<void>>();
  return {
    run: (key, task) => {
      const previous = tails.get(key) ?? Promise.resolve();
      const current = previous.then(task);
      // A rejected task must not stall the tasks queued behind it.
      const tail = current.then(ignore, ignore);
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return current;
    },
  };
};

const ignore = () => {};
