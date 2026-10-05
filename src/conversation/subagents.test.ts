import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildHistory } from "../presentation/history.ts";
import { pageTimeline } from "../presentation/history-page.ts";
import type { SubagentThread } from "../presentation/subagent.ts";
import {
  prompt,
  reply,
  toolResult,
  toolUse,
} from "../presentation/testing/session-record.ts";
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

  test("shows the text a running agent has streamed so far, and its whole text once it completes", () => {
    const subagents = createSubagents({ send: () => {} });

    subagents.start(agent("th-1", "toolu-1"));
    const [child] = subagents.childrenOf("th-1");
    const stream = (event: object) =>
      subagents.message("th-1", streamEvent("toolu-1", event));
    const items = () => subagents.historyOf(child?.id ?? "")?.[0]?.items;
    stream({ type: "message_start", message: { id: "msg-1" } });
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking" },
    });
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Where " },
    });
    stream({
      type: "content_block_start",
      index: 1,
      content_block: { type: "text" },
    });
    stream({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "Found " },
    });

    expect(items()).toMatchObject([
      { item: { type: "userMessage" } },
      {
        item: { type: "reasoning", content: ["Where "] },
        completedAtMs: null,
      },
      { item: { type: "agentMessage", text: "Found " }, completedAtMs: null },
    ]);

    stream({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "it." },
    });
    stream({ type: "content_block_stop", index: 1 });
    subagents.message("th-1", {
      type: "assistant",
      message: {
        id: "msg-1",
        content: [
          { type: "thinking", thinking: "Where ", signature: "" },
          { type: "text", text: "Found it." },
        ],
        stop_reason: null,
      },
      parent_tool_use_id: "toolu-1",
    } as unknown as SDKMessage);
    stream({ type: "message_delta", delta: { stop_reason: "end_turn" } });
    stream({ type: "message_stop" });

    expect(items()).toMatchObject([
      { item: { type: "userMessage" } },
      { item: { type: "reasoning", content: ["Where "] } },
      { item: { type: "agentMessage", text: "Found it." } },
    ]);
    expect(items()?.map(({ item }) => item.type)).toEqual([
      "userMessage",
      "reasoning",
      "agentMessage",
    ]);
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

test("keeps a nested agent's activity in its parent agent's turn, even once that turn ended", () => {
  const subagents = createSubagents({ send: () => {} });

  subagents.start(agent("th-1", "toolu-1"));
  const [outer] = subagents.childrenOf("th-1");
  subagents.message("th-1", agentCall("toolu-1", "toolu-inner"));
  subagents.start({ ...agent("th-1", "toolu-inner"), depth: 2 });
  subagents.complete("th-1", "task-toolu-1", DONE);
  subagents.complete("th-1", "task-toolu-inner", DONE);

  expect(
    subagents
      .historyOf(outer?.id ?? "")?.[0]
      ?.items.filter((entry) => entry.item.type === "subAgentActivity")
      .map((entry) => entry.item),
  ).toMatchObject([{ kind: "started" }, { kind: "completed" }]);
});

test("adds a nested agent's completion to its parent agent's last turn once that agent has ended", () => {
  const sent: Notification[] = [];
  const subagents = createSubagents({
    send: (m) => sent.push(m as Notification),
  });

  subagents.start(agent("th-1", "toolu-1"));
  const [outer] = subagents.childrenOf("th-1");
  subagents.message("th-1", agentCall("toolu-1", "toolu-inner"));
  subagents.start({ ...agent("th-1", "toolu-inner"), depth: 2 });
  subagents.complete("th-1", "task-toolu-1", DONE);
  subagents.start({ ...agent("th-1", "toolu-2"), taskId: "task-toolu-1" });
  subagents.complete("th-1", "task-toolu-1", DONE);
  subagents.complete("th-1", "task-toolu-inner", DONE);

  const lastTurn = `${outer?.id}-turn-2`;
  const entries = pageTimeline(subagents.historyOf(outer?.id ?? "") ?? [], {
    cursor: null,
    limit: null,
  })?.data;
  expect(entries?.slice(-2)).toMatchObject([
    {
      type: "item",
      turnId: lastTurn,
      item: { type: "subAgentActivity", kind: "completed" },
    },
    { type: "turnCompleted", turnId: lastTurn },
  ]);
  expect(
    entries?.filter(
      (entry) =>
        entry.type === "item" && entry.item.type === "subAgentActivity",
    ),
  ).toHaveLength(2);
  expect(
    sent.filter(
      (m) =>
        m.method === "item/completed" &&
        m.params.threadId === outer?.id &&
        m.params.item?.type === "subAgentActivity",
    ),
  ).toMatchObject([
    { params: { turnId: `${outer?.id}-turn-1` } },
    { params: { turnId: lastTurn } },
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

test("names a resumed agent's calls apart, with only the running one still open", () => {
  const subagents = createSubagents({ send: () => {} });

  subagents.start(agent("th-1", "toolu-1"));
  subagents.complete("th-1", "task-toolu-1", DONE);
  subagents.start({ ...agent("th-1", "toolu-2"), taskId: "task-toolu-1" });
  const refOf = subagents.agentRefOf("th-1");

  expect([refOf("toolu-1")?.active, refOf("toolu-2")?.active]).toEqual([
    false,
    true,
  ]);
});

test("shows in the parent's history an agent started, completed and resumed by SendMessage, with only the running call left open", () => {
  const subagents = createSubagents({ send: () => {} });
  subagents.start(agent("th-1", "toolu-1"));
  subagents.complete("th-1", "task-toolu-1", DONE);
  subagents.start({ ...agent("th-1", "toolu-send"), taskId: "task-toolu-1" });
  const [child] = subagents.childrenOf("th-1");

  const history = buildHistory(
    [
      prompt("p1", "look around"),
      reply(
        "p2",
        "m1",
        toolUse("toolu-1", "Agent", { prompt: "look" }),
        "tool_use",
      ),
      toolResult("p3", "toolu-1", "found it"),
      prompt("p4", "look again"),
      reply(
        "p5",
        "m2",
        toolUse("toolu-send", "SendMessage", {
          to: "task-toolu-1",
          message: "look again",
        }),
        "tool_use",
      ),
    ],
    { threadId: "th-1", cwd: "/fixture/work" },
    subagents.agentRefOf("th-1"),
  );

  expect(
    history.map((turn) =>
      turn.items
        .map(({ item }) => item)
        .filter((item) => item.type === "subAgentActivity")
        .map((item) => item.id),
    ),
  ).toEqual([
    [`${child?.id}-started-toolu-1`, `${child?.id}-completed-toolu-1`],
    [`${child?.id}-started-toolu-send`],
  ]);
});

test("places a read-back agent under its parent's path as the parent ended up", () => {
  const subagents = createSubagents({ send: () => {} });
  subagents.start(agent("th-1", "toolu-live"));
  subagents.restore([
    {
      thread: restoredAgent("old", "th-1", "/root/explore_1"),
      history: [],
      edits: new Map(),
    },
    {
      thread: restoredAgent("old-child", "old", "/root/explore_1/explore_1"),
      history: [],
      edits: new Map(),
    },
  ]);

  expect(subagents.descendantsOf("th-1").map((child) => child.path)).toEqual([
    "/root/explore_1",
    "/root/explore_2",
    "/root/explore_2/explore_1",
  ]);
});

// The read-back agent's history was built with the paths its agents had in the records, before a live agent's path moved them.
test("names in a read-back agent's history the path its nested agent holds after a live agent moved it", () => {
  const subagents = createSubagents({ send: () => {} });
  subagents.start(agent("th-1", "toolu-live"));
  const nested = restoredAgent("old-child", "old", "/root/explore_1/explore_1");

  subagents.restore([
    {
      thread: restoredAgent("old", "th-1", "/root/explore_1"),
      history: buildHistory(
        [
          prompt("o1", "look around"),
          reply(
            "o2",
            "m1",
            toolUse(nested.toolUseId, "Agent", { prompt: "dig" }),
            "tool_use",
          ),
        ],
        { threadId: "old", cwd: "/fixture/work" },
        () => ({
          threadId: nested.id,
          path: nested.path,
          active: false,
          edits: [],
        }),
      ),
      edits: new Map(),
    },
    { thread: nested, history: [], edits: new Map() },
  ]);

  const activity = subagents
    .historyOf("old")
    ?.flatMap((entry) => entry.items)
    .find((entry) => entry.item.type === "subAgentActivity")?.item;
  expect(subagents.get("old-child")?.path).toBe("/root/explore_2/explore_1");
  expect(activity).toMatchObject({ agentPath: "/root/explore_2/explore_1" });
});

test("shows an edit an agent applied in the turn that started it, leaving out failed and declined ones", () => {
  const sent: Notification[] = [];
  const subagents = createSubagents({
    send: (m) => sent.push(m as Notification),
  });

  subagents.start(agent("th-1", "toolu-1"));
  const [child] = subagents.childrenOf("th-1");
  for (const m of editBy("toolu-1", "toolu-ok", "/fixture/work/a.ts")) {
    subagents.message("th-1", m);
  }
  const [failedCall, failedResult] = editBy(
    "toolu-1",
    "toolu-failed",
    "/fixture/work/b.ts",
    true,
  );
  subagents.message("th-1", failedCall as SDKMessage);
  subagents.message("th-1", failedResult as SDKMessage);
  const [refusedCall, refusedResult] = editBy(
    "toolu-1",
    "toolu-refused",
    "/fixture/work/c.ts",
    true,
  );
  subagents.message("th-1", refusedCall as SDKMessage);
  subagents.decline("th-1", "toolu-refused");
  subagents.message("th-1", refusedResult as SDKMessage);

  expect(
    sent.filter(
      (m) =>
        m.params.threadId === "th-1" && m.params.item?.type === "fileChange",
    ),
  ).toMatchObject([
    {
      method: "item/started",
      params: { turnId: "turn-1", item: { status: "completed" } },
    },
    {
      method: "item/completed",
      params: {
        turnId: "turn-1",
        item: {
          status: "completed",
          changes: [{ path: "/fixture/work/a.ts" }],
        },
      },
    },
  ]);
  expect(subagents.agentRefOf("th-1")("toolu-1")?.edits).toMatchObject([
    { changes: [{ path: "/fixture/work/a.ts" }] },
  ]);
  expect(
    subagents
      .historyOf(child?.id ?? "")?.[0]
      ?.items.filter((entry) => entry.item.type === "fileChange")
      .map((entry) => entry.item),
  ).toMatchObject([
    { status: "completed" },
    { status: "failed" },
    { status: "declined" },
  ]);
});

test("keeps an edit a background agent applied after a later turn started in the turn that started the agent", () => {
  const sent: Notification[] = [];
  const subagents = createSubagents({
    send: (m) => sent.push(m as Notification),
  });

  subagents.start(agent("th-1", "toolu-1"));
  subagents.start({ ...agent("th-1", "toolu-2"), turnId: "turn-2" });
  for (const m of editBy("toolu-1", "toolu-edit", "/fixture/work/a.ts")) {
    subagents.message("th-1", m);
  }

  expect(
    sent
      .filter(
        (m) =>
          m.method === "item/completed" &&
          m.params.threadId === "th-1" &&
          m.params.item?.type === "fileChange",
      )
      .map((m) => m.params.turnId),
  ).toEqual(["turn-1"]);
  expect(subagents.agentRefOf("th-1")("toolu-2")?.edits).toEqual([]);
});

test("passes a nested agent's edit up to the agent that started it and to the thread the work came from", () => {
  const sent: Notification[] = [];
  const subagents = createSubagents({
    send: (m) => sent.push(m as Notification),
  });

  subagents.start(agent("th-1", "toolu-1"));
  const [outer] = subagents.childrenOf("th-1");
  subagents.message("th-1", agentCall("toolu-1", "toolu-inner"));
  subagents.start({ ...agent("th-1", "toolu-inner"), depth: 2 });
  const [inner] = subagents.childrenOf(outer?.id ?? "");
  for (const m of editBy("toolu-inner", "toolu-edit", "/fixture/work/a.ts")) {
    subagents.message("th-1", m);
  }

  expect(
    sent
      .filter(
        (m) =>
          m.method === "item/completed" && m.params.item?.type === "fileChange",
      )
      .map((m) => `${m.params.threadId} ${m.params.turnId}`),
  ).toEqual([
    `${inner?.id} ${inner?.id}-turn-1`,
    `${outer?.id} ${outer?.id}-turn-1`,
    "th-1 turn-1",
  ]);
  expect(
    subagents
      .historyOf(outer?.id ?? "")?.[0]
      ?.items.filter((entry) => entry.item.type === "fileChange"),
  ).toHaveLength(1);
  const refOf = subagents.agentRefOf("th-1");
  expect(
    [refOf("toolu-1"), refOf("toolu-inner")].map((ref) =>
      ref?.edits.map((edit) => edit.changes[0]?.path),
    ),
  ).toEqual([["/fixture/work/a.ts"], ["/fixture/work/a.ts"]]);
});

test("keeps a nested agent's edit in the turn of its parent agent that started it after that agent was resumed", () => {
  const sent: Notification[] = [];
  const subagents = createSubagents({
    send: (m) => sent.push(m as Notification),
  });

  subagents.start(agent("th-1", "toolu-1"));
  const [outer] = subagents.childrenOf("th-1");
  subagents.message("th-1", agentCall("toolu-1", "toolu-inner"));
  subagents.start({ ...agent("th-1", "toolu-inner"), depth: 2 });
  subagents.complete("th-1", "task-toolu-1", DONE);
  subagents.start({
    ...agent("th-1", "toolu-2"),
    turnId: "turn-2",
    taskId: "task-toolu-1",
  });
  for (const m of editBy("toolu-inner", "toolu-edit", "/fixture/work/a.ts")) {
    subagents.message("th-1", m);
  }

  expect(
    subagents
      .historyOf(outer?.id ?? "")
      ?.map(
        (entry) =>
          entry.items.filter((kept) => kept.item.type === "fileChange").length,
      ),
  ).toEqual([1, 0]);
  expect(
    sent
      .filter(
        (m) =>
          m.method === "item/completed" &&
          m.params.item?.type === "fileChange" &&
          m.params.threadId !== subagents.childrenOf(outer?.id ?? "")[0]?.id,
      )
      .map((m) => m.params.turnId),
  ).toEqual([`${outer?.id}-turn-1`, "turn-1"]);
});

test("shows in the parent's history an agent's edits in the turn whose call started it, once per read", () => {
  const subagents = createSubagents({ send: () => {} });
  subagents.start(agent("th-1", "toolu-1"));
  for (const m of editBy("toolu-1", "toolu-edit", "/fixture/work/a.ts")) {
    subagents.message("th-1", m);
  }
  subagents.complete("th-1", "task-toolu-1", DONE);
  const record = [
    prompt("p1", "look around"),
    reply(
      "p2",
      "m1",
      toolUse("toolu-1", "Agent", { prompt: "look", run_in_background: true }),
      "tool_use",
    ),
    toolResult("p3", "toolu-1", "started in the background"),
    prompt("p4", "something else"),
    reply("p5", "m2", { type: "text", text: "sure" }, "end_turn"),
  ];

  const read = () =>
    buildHistory(
      record,
      { threadId: "th-1", cwd: "/fixture/work" },
      subagents.agentRefOf("th-1"),
    ).map((turn) =>
      turn.items.flatMap(({ item }) =>
        item.type === "subAgentActivity"
          ? [item.kind]
          : item.type === "fileChange"
            ? [item.changes[0]?.path]
            : [],
      ),
    );

  expect(read()).toEqual([["started", "/fixture/work/a.ts", "completed"], []]);
  expect(read()).toEqual(read());
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

// An agent read back from Claude's records, which joins as ended.
const restoredAgent = (
  id: string,
  parentThreadId: string,
  path: string,
): SubagentThread => ({
  id,
  rootThreadId: "th-1",
  parentThreadId,
  depth: parentThreadId === "th-1" ? 1 : 2,
  calls: [`toolu-${id}`],
  toolUseId: `toolu-${id}`,
  taskId: id,
  nickname: id,
  role: "Explore",
  path,
  turnId: null,
  runs: 1,
  active: false,
  createdAtMs: 0,
  updatedAtMs: 0,
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
  cwd: "/fixture/work",
  prompt: "look around the repository",
  depth: 1,
});

type Notification = {
  method: string;
  params: {
    threadId?: string;
    turnId?: string;
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

const streamEvent = (parentToolUseId: string, event: object) =>
  ({
    type: "stream_event",
    event,
    parent_tool_use_id: parentToolUseId,
  }) as unknown as SDKMessage;

// An agent's Edit call and Claude's answer to it, which carries the applied hunks only when the edit succeeded.
const editBy = (
  parentToolUseId: string,
  toolUseId: string,
  path: string,
  failed = false,
): SDKMessage[] => [
  {
    type: "assistant",
    message: {
      id: `msg-${toolUseId}`,
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "Edit",
          input: { file_path: path, old_string: "a", new_string: "b" },
        },
      ],
      stop_reason: null,
    },
    parent_tool_use_id: parentToolUseId,
  } as unknown as SDKMessage,
  {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: failed ? "String to replace not found" : "updated",
          is_error: failed,
        },
      ],
    },
    parent_tool_use_id: parentToolUseId,
    tool_use_result: failed
      ? undefined
      : {
          filePath: path,
          structuredPatch: [
            {
              oldStart: 3,
              oldLines: 1,
              newStart: 3,
              newLines: 1,
              lines: ["-a", "+b"],
            },
          ],
        },
  } as unknown as SDKMessage,
];

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
