export type DelegationWatch = ReturnType<typeof createDelegationWatch>;

// The app answers create_thread with a provisional id only; the real thread id first appears in the turn/start the app sends to the new thread, whose tool output names the thread that asked for it.
export const createDelegationWatch = () => {
  const waiters = new Map<string, ((threadId: string) => void)[]>();
  // Threads already matched to a create_thread, so their late or repeated first turn never answers a later one.
  const claimed = new Set<string>();

  // A thread created from anywhere but a pending create_thread of a Claude thread is ignored, so it can never become someone's reviewer.
  const observe = (sourceThreadId: string, threadId: string) => {
    if (claimed.has(threadId)) return;
    const queue = waiters.get(sourceThreadId);
    const next = queue?.shift();
    if (queue?.length === 0) waiters.delete(sourceThreadId);
    if (next === undefined) return;
    claimed.add(threadId);
    next(threadId);
  };

  // Registered before create_thread is sent, since the new thread's turn/start can arrive before the tool answer.
  const expect = (sourceThreadId: string) => {
    let resolve: (threadId: string | null) => void = () => {};
    const created = new Promise<string | null>((done) => {
      resolve = done;
    });
    const queue = waiters.get(sourceThreadId) ?? [];
    waiters.set(sourceThreadId, [...queue, resolve]);
    const cancel = () => {
      const left = (waiters.get(sourceThreadId) ?? []).filter(
        (waiter) => waiter !== resolve,
      );
      if (left.length === 0) waiters.delete(sourceThreadId);
      else waiters.set(sourceThreadId, left);
      resolve(null);
    };
    return {
      wait: async (timeoutMs: number) => {
        const timer = setTimeout(cancel, timeoutMs);
        try {
          return await created;
        } finally {
          clearTimeout(timer);
        }
      },
      cancel,
      // The app's answer named the thread itself, so its first turn arriving later must not answer another create_thread.
      claim: (threadId: string) => {
        claimed.add(threadId);
        cancel();
      },
    };
  };

  return { observe, expect };
};

// Only the create_thread tool output carries the delegation, as <source_thread_id>…</source_thread_id> in text the app writes.
export const delegationSource = (params: Record<string, unknown>) => {
  const output = params.toolOutput;
  if (
    typeof output !== "object" ||
    output === null ||
    !("name" in output) ||
    output.name !== "create_thread" ||
    !("output" in output)
  ) {
    return null;
  }
  const body = JSON.stringify(output.output) ?? "";
  return SOURCE_THREAD.exec(body)?.[1] ?? null;
};

const SOURCE_THREAD =
  /<source_thread_id>\s*([0-9A-Za-z_-]+)\s*<\/source_thread_id>/;
