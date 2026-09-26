import { isObject } from "../../runtime/object.ts";

export type DelegationWatch = ReturnType<typeof createDelegationWatch>;

// The app answers create_thread with a provisional id only; the real thread id first appears in the turn/start the app sends to the new thread, whose tool output names the thread that asked for it.
// claim runs as a thread is handed to its caller, before the caller's wait resumes, so the thread is known as that caller's from the moment it is seen.
export const createDelegationWatch = (
  claim: (sourceThreadId: string, threadId: string) => void,
) => {
  const waiters = new Map<string, ((threadId: string) => void)[]>();
  // Every thread seen or named by an answer, so its late or repeated first turn never answers a later create_thread.
  const claimed = new Set<string>();

  // A thread created from anywhere but a pending create_thread of a Claude thread is ignored, so it can never become someone's reviewer.
  const observe = (sourceThreadId: string, threadId: string) => {
    if (claimed.has(threadId)) return;
    claimed.add(threadId);
    const queue = waiters.get(sourceThreadId);
    const next = queue?.shift();
    if (queue?.length === 0) waiters.delete(sourceThreadId);
    if (next === undefined) return;
    claim(sourceThreadId, threadId);
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

// Only the create_thread tool output names the thread that created the one it starts.
export const delegationSource = (params: Record<string, unknown>) => {
  const message = delegatedMessage(params);
  return message?.tool === "create_thread" ? message.sourceThreadId : null;
};

// A message from another thread arrives as the output of the codex_app call that sent it, with the sender as <source_thread_id>…</source_thread_id> in text the app writes; only an output made of text can reach Claude.
export const delegatedMessage = (params: Record<string, unknown>) => {
  const output = params.toolOutput;
  if (
    !isObject(output) ||
    typeof output.name !== "string" ||
    !DELEGATING_TOOLS.has(output.name)
  ) {
    return null;
  }
  const texts = outputTexts(output.output);
  if (texts === null) return null;
  const text = texts.join("\n");
  return {
    tool: output.name,
    text,
    sourceThreadId: SOURCE_THREAD.exec(text)?.[1] ?? null,
    toolOutput: {
      name: output.name,
      namespace: typeof output.namespace === "string" ? output.namespace : null,
      output:
        typeof output.output === "string" ? output.output : textItems(texts),
    },
  };
};

const textItems = (
  texts: readonly string[],
): readonly { type: "input_text"; text: string }[] =>
  texts.map((text) => ({ type: "input_text", text }));

const outputTexts = (body: unknown) => {
  if (typeof body === "string") return [body];
  if (!Array.isArray(body) || body.length === 0) return null;
  const texts: string[] = [];
  for (const item of body) {
    if (
      !isObject(item) ||
      item.type !== "input_text" ||
      typeof item.text !== "string"
    ) {
      return null;
    }
    texts.push(item.text);
  }
  return texts;
};

const DELEGATING_TOOLS: ReadonlySet<string> = new Set([
  "create_thread",
  "send_message_to_thread",
]);

const SOURCE_THREAD =
  /<source_thread_id>\s*([0-9A-Za-z_-]+)\s*<\/source_thread_id>/;
