import { describe, expect, test } from "bun:test";
import { createSubagents } from "./subagents.ts";

describe("subagents", () => {
  test("gives the same agent the same UUID-shaped thread id", () => {
    const first = createSubagents({ send: () => {} });
    const second = createSubagents({ send: () => {} });

    first.start(agent("th-1", "toolu-1"));
    second.start(agent("th-1", "toolu-1"));
    first.start(agent("th-1", "toolu-2"));

    const [one, two] = first.childrenOf("th-1");
    expect(one?.id).toBe(second.childrenOf("th-1")[0]?.id);
    expect(one?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(two?.id).not.toBe(one?.id);
  });

  test("names each agent's path as Codex writes one, numbered within its parent", () => {
    const subagents = createSubagents({ send: () => {} });

    subagents.start(agent("th-1", "toolu-1", "general-purpose"));
    subagents.start(agent("th-1", "toolu-2", "Root"));
    subagents.start(agent("th-2", "toolu-3", null));

    expect(
      [...subagents.childrenOf("th-1"), ...subagents.childrenOf("th-2")].map(
        (child) => child.path,
      ),
    ).toEqual(["/root/general_purpose_1", "/root/agent_2", "/root/agent_1"]);
  });

  test("tells the app of an agent once when it starts and once when it completes", () => {
    const sent: object[] = [];
    const subagents = createSubagents({ send: (m) => sent.push(m) });

    subagents.start(agent("th-1", "toolu-1"));
    subagents.start(agent("th-1", "toolu-1"));
    subagents.complete("th-1", "task-toolu-1");
    subagents.complete("th-1", "task-toolu-1");
    subagents.complete("th-1", "task-unknown");

    expect(sent.map((m) => (m as { method: string }).method)).toEqual([
      "item/started",
      "item/completed",
      "thread/status/changed",
      "thread/status/changed",
      "item/started",
      "item/completed",
    ]);
  });
});

test("starts a resumed agent again on the thread it had", () => {
  const sent: { params: { item?: { id: string } } }[] = [];
  const subagents = createSubagents({
    send: (m) => sent.push(m as (typeof sent)[number]),
  });

  subagents.start(agent("th-1", "toolu-1"));
  subagents.complete("th-1", "task-toolu-1");
  subagents.start({ ...agent("th-1", "toolu-2"), taskId: "task-toolu-1" });

  expect(subagents.childrenOf("th-1")).toMatchObject([
    { active: true, runs: 2 },
  ]);
  const itemIds = sent.flatMap((m) =>
    m.params.item === undefined ? [] : [m.params.item.id],
  );
  expect(new Set(itemIds).size).toBe(itemIds.length / 2);
});

test("ends every running agent of a thread whose session closed", () => {
  const subagents = createSubagents({ send: () => {} });

  subagents.start(agent("th-1", "toolu-1"));
  subagents.start(agent("th-1", "toolu-2"));
  subagents.start(agent("th-2", "toolu-3"));
  subagents.settle("th-1");

  expect(
    [...subagents.childrenOf("th-1"), ...subagents.childrenOf("th-2")].map(
      (child) => child.active,
    ),
  ).toEqual([false, false, true]);
});

const agent = (
  threadId: string,
  toolUseId: string,
  agentType: string | null = "Explore",
) => ({
  threadId,
  turnId: "turn-1",
  toolUseId,
  taskId: `task-${toolUseId}`,
  description: "look around",
  agentType,
});
