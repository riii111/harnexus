// The server numbers its own requests to the app, so the bridge's string ids with this prefix never collide with them.
const ID_PREFIX = "harnexus-";

// The app keeps a prompt open until told its request is resolved, so every settled request is announced, answered or not.
export const createAppRequests = ({
  send,
  now,
}: {
  send: (message: object) => void;
  now: () => number;
}) => {
  const pending = new Map<
    string,
    { threadId: string; settle: (answer: unknown) => void }
  >();
  let sequence = 0;

  const ask = (
    threadId: string,
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ) =>
    new Promise<unknown>((resolve) => {
      if (signal.aborted) {
        resolve(null);
        return;
      }
      const id = `${ID_PREFIX}${++sequence}`;
      const settle = (answer: unknown) => {
        if (!pending.delete(id)) return;
        signal.removeEventListener("abort", abort);
        send({
          method: "serverRequest/resolved",
          params: { threadId, requestId: id },
          emittedAtMs: now(),
        });
        resolve(answer);
      };
      const abort = () => settle(null);
      signal.addEventListener("abort", abort, { once: true });
      pending.set(id, { threadId, settle });
      send({ id, method, params });
    });

  // A late answer to a request that already settled is still consumed, since the server never issued that id.
  const answer = (response: Record<string, unknown>) => {
    const { id } = response;
    if (typeof id !== "string" || !id.startsWith(ID_PREFIX)) return false;
    pending.get(id)?.settle("result" in response ? response.result : null);
    return true;
  };

  const cancel = (threadId: string | null) => {
    for (const request of [...pending.values()]) {
      if (threadId === null || request.threadId === threadId) {
        request.settle(null);
      }
    }
  };

  return { ask, answer, cancel };
};
