import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

// Synthetic records in the shape getSessionMessages returns, one content block per assistant record as Claude Code writes them.

export const prompt = (
  uuid: string,
  text: string,
  at: string | null = null,
): SessionMessage => record("user", uuid, { role: "user", content: text }, at);

export const reply = (
  uuid: string,
  messageId: string,
  block: object,
  stopReason: string,
  at: string | null = null,
): SessionMessage =>
  record(
    "assistant",
    uuid,
    {
      id: messageId,
      type: "message",
      role: "assistant",
      model: "claude-fixture",
      content: [block],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {},
    },
    at,
  );

export const toolResult = (
  uuid: string,
  toolUseId: string,
  content: string,
  isError = false,
  at: string | null = null,
): SessionMessage =>
  record(
    "user",
    uuid,
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content,
          is_error: isError,
        },
      ],
    },
    at,
  );

export const text = (value: string) => ({ type: "text", text: value });

export const thinking = (value: string) => ({
  type: "thinking",
  thinking: value,
  signature: "",
});

export const toolUse = (id: string, name: string, input: object) => ({
  type: "tool_use",
  id,
  name,
  input,
});

// A two-turn conversation: a tool call answered with a final message, then a plain reply.
export const conversation = (): SessionMessage[] => [
  prompt("u1", "list the files", "2026-09-27T00:00:00.000Z"),
  reply(
    "a1",
    "m1",
    thinking("look first"),
    "tool_use",
    "2026-09-27T00:00:01.000Z",
  ),
  reply(
    "a2",
    "m1",
    toolUse("tool-1", "Bash", { command: "ls" }),
    "tool_use",
    "2026-09-27T00:00:01.000Z",
  ),
  toolResult("r1", "tool-1", "a.txt", false, "2026-09-27T00:00:02.000Z"),
  reply("a3", "m2", text("one file"), "end_turn", "2026-09-27T00:00:03.000Z"),
  prompt("u2", "thanks", "2026-09-27T00:01:00.000Z"),
  reply("a4", "m3", text("welcome"), "end_turn", "2026-09-27T00:01:02.000Z"),
];

const record = (
  type: "user" | "assistant",
  uuid: string,
  message: object,
  at: string | null,
): SessionMessage => ({
  type,
  uuid,
  session_id: "session-fixture",
  message,
  parent_tool_use_id: null,
  parent_agent_id: null,
  ...(at !== null && { timestamp: at }),
});
