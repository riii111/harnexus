import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
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

  test("runs one turn in the agent's thread from its start to its completion", () => {
    const sent: Notification[] = [];
    const subagents = createSubagents({
      send: (m) => sent.push(m as Notification),
    });

    subagents.start(agent("th-1", "toolu-1"));
    subagents.start(agent("th-1", "toolu-1"));
    const [child] = subagents.childrenOf("th-1");
    subagents.message("th-1", {
      type: "assistant",
      message: {
        id: "msg-1",
        content: [{ type: "text", text: "found it" }],
        stop_reason: "end_turn",
      },
      parent_tool_use_id: "toolu-1",
    } as unknown as SDKMessage);
    subagents.complete("th-1", "task-toolu-1", DONE);
    subagents.complete("th-1", "task-toolu-1", DONE);
    subagents.complete("th-1", "task-unknown", DONE);

    expect(
      sent.filter((m) => m.method !== "item/started").map(summary),
    ).toEqual([
      "th-1 item/completed subAgentActivity",
      `${child?.id} thread/status/changed active`,
      `${child?.id} turn/started`,
      `${child?.id} item/completed userMessage`,
      `${child?.id} item/completed agentMessage`,
      `${child?.id} thread/status/changed idle`,
      `${child?.id} turn/completed`,
      "th-1 item/completed subAgentActivity",
    ]);
    expect(subagents.historyOf(child?.id ?? "")).toMatchObject([
      {
        turn: { status: "completed" },
        items: [
          { item: { type: "userMessage" } },
          { item: { type: "agentMessage", text: "found it" } },
        ],
      },
    ]);
  });

  test("shows a running agent's turn as in progress with what it has done so far", () => {
    const subagents = createSubagents({ send: () => {} });

    subagents.start(agent("th-1", "toolu-1"));
    const [child] = subagents.childrenOf("th-1");

    expect(subagents.historyOf(child?.id ?? "")).toMatchObject([
      {
        turn: { status: "inProgress" },
        items: [{ item: { type: "userMessage" } }],
      },
    ]);
    expect(subagents.historyOf("th-1")).toBeUndefined();
  });
});

test("starts a resumed agent again on the thread it had", () => {
  const sent: { params: { item?: { id: string } } }[] = [];
  const subagents = createSubagents({
    send: (m) => sent.push(m as (typeof sent)[number]),
  });

  subagents.start(agent("th-1", "toolu-1"));
  subagents.complete("th-1", "task-toolu-1", DONE);
  subagents.start({ ...agent("th-1", "toolu-2"), taskId: "task-toolu-1" });

  expect(subagents.childrenOf("th-1")).toMatchObject([
    { active: true, runs: 2 },
  ]);
  const itemIds = sent.flatMap((m) =>
    m.params.item === undefined ? [] : [m.params.item.id],
  );
  expect(new Set(itemIds).size).toBe(itemIds.length / 2);
});

test("places an agent another agent started under that agent's thread", () => {
  const sent: Notification[] = [];
  const subagents = createSubagents({
    send: (m) => sent.push(m as Notification),
  });

  subagents.start(agent("th-1", "toolu-1"));
  const [outer] = subagents.childrenOf("th-1");
  subagents.message("th-1", agentCall("toolu-1", "toolu-inner"));
  subagents.start({ ...agent("th-1", "toolu-inner"), depth: 2 });
  subagents.message("th-1", agentCall("toolu-inner", "toolu-deepest"));

  const [inner] = subagents.childrenOf(outer?.id ?? "");
  expect(inner).toMatchObject({
    rootThreadId: "th-1",
    parentThreadId: outer?.id,
    depth: 2,
    path: "/root/explore_1/explore_1",
    turnId: `${outer?.id}-turn-1`,
  });
  expect(
    subagents
      .descendantsOf("th-1")
      .map((child): string | undefined => child.id),
  ).toEqual([outer?.id, inner?.id]);
  expect(
    sent
      .filter((m) => m.params.item?.type === "subAgentActivity")
      .map((m) => m.params.threadId),
  ).toContain(outer?.id);
  expect(subagents.historyOf(inner?.id ?? "")).toMatchObject([
    {
      items: [
        { item: { type: "userMessage" } },
        { item: { type: "mcpToolCall", tool: "Agent" } },
      ],
    },
  ]);
});

test("leaves out an agent whose caller is unknown", () => {
  const subagents = createSubagents({ send: () => {} });

  subagents.start({ ...agent("th-1", "toolu-inner"), depth: 2 });

  expect(subagents.descendantsOf("th-1")).toEqual([]);
});

test("closes a call refused for an agent as declined in its thread", () => {
  const subagents = createSubagents({ send: () => {} });

  subagents.start(agent("th-1", "toolu-1"));
  const [child] = subagents.childrenOf("th-1");
  subagents.message("th-1", {
    type: "assistant",
    message: {
      id: "msg-1",
      content: [
        {
          type: "tool_use",
          id: "toolu-ls",
          name: "Bash",
          input: { command: "ls" },
        },
      ],
      stop_reason: null,
    },
    parent_tool_use_id: "toolu-1",
  } as unknown as SDKMessage);
  subagents.decline("th-1", "toolu-ls");
  subagents.message("th-1", {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu-ls",
          content: "denied",
          is_error: true,
        },
      ],
    },
    parent_tool_use_id: "toolu-1",
  } as unknown as SDKMessage);

  expect(subagents.historyOf(child?.id ?? "")?.[0]?.items).toMatchObject([
    { item: { type: "userMessage" } },
    { item: { type: "commandExecution", status: "declined" } },
  ]);
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

const DONE = { status: "completed" } as const;

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
  cwd: "/fixture/work",
  prompt: "look around the repository",
  depth: 1,
});

type Notification = {
  method: string;
  params: {
    threadId?: string;
    item?: { id: string; type: string };
    status?: { type: string };
    turn?: unknown;
  };
};

const summary = (m: Notification) => {
  const { threadId, item, status } = m.params;
  if (item !== undefined) return `${threadId} ${m.method} ${item.type}`;
  if (status !== undefined) return `${threadId} ${m.method} ${status.type}`;
  return `${threadId} ${m.method}`;
};

// A message of the agent whose call started this one, carrying the Agent call that starts another.
const agentCall = (parentToolUseId: string, toolUseId: string) =>
  ({
    type: "assistant",
    message: {
      id: `msg-${toolUseId}`,
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "Agent",
          input: { prompt: "dig" },
        },
      ],
      stop_reason: null,
    },
    parent_tool_use_id: parentToolUseId,
  }) as unknown as SDKMessage;
