import { describe, expect, test } from "bun:test";
import { buildHistory } from "./history.ts";
import { renderSubagentActivity, type SubagentThread } from "./subagent.ts";
import { prompt, reply, toolUse } from "./testing/session-record.ts";

describe("renderSubagentActivity", () => {
  test.each([
    { name: "started", kind: "started" as const, active: true },
    { name: "completed", kind: "completed" as const, active: false },
  ])("names the $name activity as a history rebuilt from the record does", ({
    kind,
    active,
  }) => {
    const live = renderSubagentActivity(CHILD, kind, 1).flatMap(
      (notification) =>
        notification.method === "item/started"
          ? [notification.params.item.id]
          : [],
    );

    const [turn] = buildHistory(
      [
        prompt("u1", "go"),
        reply("a1", "m1", toolUse(CHILD.toolUseId, "Agent", {}), "tool_use"),
      ],
      { threadId: CHILD.parentThreadId, cwd: "/w" },
      (toolUseId) =>
        toolUseId === CHILD.toolUseId
          ? { threadId: CHILD.id, path: CHILD.path, active, edits: [] }
          : undefined,
    );
    const rebuilt = (turn?.items ?? []).flatMap(({ item }) =>
      item.type === "subAgentActivity" && item.kind === kind ? [item.id] : [],
    );

    expect(live).toHaveLength(1);
    expect(rebuilt).toEqual(live);
  });
});

const CHILD: SubagentThread = {
  id: "agent-thread",
  rootThreadId: "parent-thread",
  parentThreadId: "parent-thread",
  depth: 1,
  calls: ["call-1"],
  toolUseId: "call-1",
  taskId: "task-1",
  nickname: "helper",
  role: null,
  path: "/root/helper",
  turnId: "parent-turn",
  runs: 1,
  active: true,
  createdAtMs: 0,
  updatedAtMs: 0,
};
