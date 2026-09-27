import { randomUUID } from "node:crypto";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// The SDK reads this stream for the whole session; a message pushed mid-turn joins the running turn at a tool boundary or queues a new turn, and its uuid is how an interrupt reports it as still queued.
export const createPromptQueue = () => {
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
    push: (text: string, attachments: readonly string[] = []) => {
      if (ended) return null;
      const message = userMessage(text, attachments);
      queued.push(message);
      notify();
      return message.uuid;
    },
    end: () => {
      ended = true;
      notify();
    },
  };
};

// Attachments follow the typed text as blocks of their own, so the record keeps the typed text apart from what the bridge added.
const userMessage = (text: string, attachments: readonly string[]) =>
  ({
    type: "user",
    message: {
      role: "user",
      content:
        attachments.length === 0
          ? text
          : [text, ...attachments].map((part) => ({
              type: "text" as const,
              text: part,
            })),
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  }) satisfies SDKUserMessage;
