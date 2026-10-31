export const ABORTED = Symbol("aborted");

export const waitForAbort = <T>(pending: Promise<T>, signal: AbortSignal) =>
  new Promise<T | typeof ABORTED>((resolve, reject) => {
    if (signal.aborted) {
      resolve(ABORTED);
      return;
    }
    const abort = () => {
      signal.removeEventListener("abort", abort);
      resolve(ABORTED);
    };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(cause);
      },
    );
  });
