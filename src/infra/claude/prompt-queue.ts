import { randomUUID } from "node:crypto";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ImageBlock } from "./images.ts";

// attachments are text the bridge adds after what was typed, such as a skill's body.
export type Prompt = {
  text: string;
  images?: readonly ImageBlock[];
  attachments?: readonly string[];
};

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
    push: (prompt: Prompt) => {
      if (ended) return null;
      const message = userMessage(prompt);
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

// Images come first, as Claude reads a question best after the image it asks about; the typed text is the first text block and attachments follow it, so the record keeps the typed text apart from what the bridge added.
// Claude refuses an empty text block, so a message of images alone carries no text; attachments come only from links in the typed text, so they never stand first.
const userMessage = ({ text, images = [], attachments = [] }: Prompt) =>
  ({
    type: "user",
    message: {
      role: "user",
      content:
        images.length === 0 && attachments.length === 0
          ? text
          : [...images, ...(text === "" ? [] : [text]), ...attachments].map(
              (part) =>
                typeof part === "string"
                  ? { type: "text" as const, text: part }
                  : part,
            ),
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  }) satisfies SDKUserMessage;
