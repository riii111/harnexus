import type { fakeClaude } from "../../../infra/claude/testing/fake-claude.ts";
import type { createTurnController } from "../../controller.ts";
import { result, type Sent, THREAD } from "../../testing/harness.ts";

export type Turns = ReturnType<typeof createTurnController>;

export type FakeClaude = ReturnType<typeof fakeClaude>;

export const ALLOWED = { answers: { approval: { answers: ["Allow"] } } };

export const steer = (id: number, turnId: string, text: string) => ({
  id,
  params: {
    threadId: THREAD,
    expectedTurnId: turnId,
    input: [{ type: "text", text, text_elements: [] }],
  } as Record<string, unknown>,
});

export const INIT = { type: "system", subtype: "init" };

export const isTurnStarted = (turnId: string) => (message: Sent) =>
  message.method === "turn/started" && message.params.turn.id === turnId;

// The result of a turn Claude started when a background task reported back, which names no send unless one joined it.
export const ownResult = (fields: object = {}) =>
  result({
    subtype: "success",
    is_error: false,
    result: "done",
    origin: { kind: "task-notification" },
    ...fields,
  });

export const taskStarted = (toolUseId: string, depth: number) => ({
  type: "system",
  subtype: "task_started",
  task_id: `task-${toolUseId}`,
  tool_use_id: toolUseId,
  description: "read the README",
  subagent_type: "Explore",
  task_type: "local_agent",
  spawn_depth: depth,
});
