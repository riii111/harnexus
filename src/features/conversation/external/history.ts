import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

import type { HistoryEntry } from "./protocol.ts";

// A bound chat's conversation as the adapter keeps it, in the shape Claude's own records take, so its history is built as any chat's is.
export const externalHistoryRecords = (
  threadId: string,
  entries: readonly HistoryEntry[],
) =>
  entries.map((entry, index) => {
    const uuid = `external-${threadId}-${index}`;
    return entry.role === "user"
      ? {
          type: "user",
          uuid,
          session_id: EXTERNAL_SESSION,
          message: { role: "user", content: entry.text },
          parent_tool_use_id: null,
          timestamp: entry.at,
        }
      : {
          type: "assistant",
          uuid,
          session_id: EXTERNAL_SESSION,
          message: {
            id: uuid,
            type: "message",
            role: "assistant",
            model: EXTERNAL_SESSION,
            content: [{ type: "text", text: entry.text }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {},
          },
          parent_tool_use_id: null,
          timestamp: entry.at,
        };
  }) as unknown as SessionMessage[];

const EXTERNAL_SESSION = "external-conversation";
