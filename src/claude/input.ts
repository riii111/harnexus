import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// The SDK keeps reading this stream for the whole session, so a message pushed mid-turn reaches the running turn.
export const createInputQueue = () => {
  const queued: SDKUserMessage[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  return {
    stream: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          const message = queued.shift();
          if (message !== undefined) {
            yield message;
            continue;
          }
          if (ended) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    } satisfies AsyncIterable<SDKUserMessage>,
    push: (text: string) => {
      if (ended) return false;
      queued.push(userMessage(text));
      notify();
      return true;
    },
    end: () => {
      ended = true;
      notify();
    },
  };
};

const userMessage = (text: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
});
