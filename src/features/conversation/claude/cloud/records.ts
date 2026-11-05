import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

import { isObject } from "../../../../lib/object.ts";

export const contentOf = (
  record: SessionMessage,
): Record<string, unknown>[] => {
  const message = isObject(record) ? record.message : null;
  const content = isObject(message) ? message.content : null;
  return Array.isArray(content) ? content.filter(isObject) : [];
};

export const textsOf = (content: unknown) =>
  typeof content === "string"
    ? [content]
    : Array.isArray(content)
      ? content.flatMap((item) =>
          isObject(item) && typeof item.text === "string" ? [item.text] : [],
        )
      : [];
