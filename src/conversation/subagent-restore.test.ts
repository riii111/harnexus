import { describe, expect, test } from "bun:test";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { Result, TaggedError } from "better-result";
import type { SubagentRecord } from "../infra/claude/session.ts";
import {
  prompt,
  reply,
  text,
  toolResult,
  toolUse,
} from "../presentation/testing/session-record.ts";
import { createHistoryRequests } from "./history-request.ts";
import { createSubagentRestore } from "./subagent-restore.ts";
import { createSubagents } from "./subagents.ts";

describe("agents read back after a restart", () => {
  test("shows each agent under the thread or agent that started it, with what it did", async () => {
    const { history, subagents } = setup(() => Result.ok(AGENTS));

    const parentHistory = await history.load(THREAD);

    const [outer] = subagents.childrenOf(THREAD);
    const [inner] = subagents.childrenOf(outer?.id ?? "");
    expect(outer).toMatchObject({
      rootThreadId: THREAD,
      depth: 1,
      path: "/root/explore_1",
      nickname: "read the README",
      active: false,
      createdAtMs: Date.parse(STARTED),
    });
    expect(inner).toMatchObject({
      parentThreadId: outer?.id,
      depth: 2,
      path: "/root/explore_1/agent_1",
    });
    expect(
      parentHistory
        .unwrap()
        .flatMap((turn) => turn.items.map(({ item }) => item))
        .filter((item) => item.type === "subAgentActivity"),
    ).toMatchObject([
      { kind: "started", agentThreadId: outer?.id, agentPath: outer?.path },
      { kind: "completed", agentThreadId: outer?.id },
    ]);
    const outerItems = (await history.load(outer?.id ?? ""))
      .unwrap()
      .flatMap((turn) => turn.items.map(({ item }) => item));
    expect(outerItems.map((item) => item.type)).toEqual([
      "userMessage",
      "mcpToolCall",
      "subAgentActivity",
      "subAgentActivity",
      "agentMessage",
    ]);
    expect(outerItems[0]).toMatchObject({
      content: [{ text: "read the README and summarize it" }],
    });
  });

  test("reads a thread's agents once and keeps the ones the bridge already knows", async () => {
    let reads = 0;
    const { history, subagents } = setup(() => {
      reads += 1;
      return Result.ok(AGENTS);
    });
    subagents.start({
      threadId: THREAD,
      turnId: "turn-1",
      toolUseId: "toolu-1",
      taskId: "a1",
      description: "live agent",
      agentType: "Explore",
      cwd: "/fixture/work",
      prompt: null,
      depth: 1,
    });

    await history.load(THREAD);
    await history.load(THREAD);

    expect(reads).toBe(1);
    expect(subagents.childrenOf(THREAD)).toMatchObject([
      { nickname: "live agent", active: true },
    ]);
  });

  test("shows a running agent as started only and numbers read-back agents past the paths live ones hold", async () => {
    const { history, subagents } = setup(() =>
      Result.ok([
        AGENTS[1] as SubagentRecord,
        {
          ...(AGENTS[1] as SubagentRecord),
          agentId: "a9",
          toolUseId: "toolu-9",
        },
      ]),
    );
    subagents.start({
      threadId: THREAD,
      turnId: "turn-1",
      toolUseId: "toolu-1",
      taskId: "a1",
      description: "live agent",
      agentType: "Explore",
      cwd: "/fixture/work",
      prompt: null,
      depth: 1,
    });

    const parentHistory = (await history.load(THREAD)).unwrap();

    expect(
      parentHistory
        .flatMap((turn) => turn.items.map(({ item }) => item))
        .filter((item) => item.type === "subAgentActivity")
        .map((item) => item.kind),
    ).toEqual(["started"]);
    expect(subagents.childrenOf(THREAD).map((child) => child.path)).toEqual([
      "/root/explore_1",
      "/root/explore_2",
    ]);
  });

  test("leaves out an agent noted as nested whose records name no parent", async () => {
    const { history, subagents } = setup(() =>
      Result.ok([{ ...(AGENTS[0] as SubagentRecord), messages: [] }]),
    );

    await history.load(THREAD);

    expect(subagents.descendantsOf(THREAD)).toEqual([]);
  });

  test("logs agents it cannot read and shows the thread's history without them", async () => {
    const { history, subagents, events } = setup(() =>
      Result.err(new Unreadable({ message: "cannot read" })),
    );

    const parentHistory = await history.load(THREAD);

    expect(parentHistory.isOk()).toBe(true);
    expect(subagents.childrenOf(THREAD)).toEqual([]);
    expect(events).toEqual([
      { event: "claude_subagents_unreadable", error: "Unreadable" },
    ]);
  });
});

class Unreadable extends TaggedError("Unreadable")<{ message: string }> {}

const setup = (read: () => Result<SubagentRecord[], Unreadable>) => {
  const subagents = createSubagents({ send: () => {} });
  const events: object[] = [];
  const restore = createSubagentRestore({
    subagents,
    readSubagents: async () => read(),
    log: (event) => events.push(event),
  });
  const history = createHistoryRequests({
    threads: {
      threadOf: () => ({ model: "claude-sonnet-5", cwd: "/fixture/work" }),
      sessionIdOf: () => "se-1",
      takePicked: () => false,
    },
    readSession: async () => Result.ok(PARENT),
    send: () => {},
    log: () => {},
    subagentHistory: subagents.historyOf,
    subagents: {
      restore: restore.restore,
      agentRefOf: subagents.agentRefOf,
    },
  });
  return { history, subagents, events };
};

const THREAD = "th-claude";

const STARTED = "2026-09-27T00:00:01.000Z";

const PARENT: SessionMessage[] = [
  prompt("p1", "summarize the README", "2026-09-27T00:00:00.000Z"),
  reply(
    "p2",
    "m1",
    toolUse("toolu-1", "Agent", { prompt: "read" }),
    "tool_use",
  ),
  toolResult("p3", "toolu-1", "a summary"),
  reply("p4", "m2", text("done"), "end_turn"),
];

// An agent's records name the call that started it as their parent, and a nested agent's also name the agent that started it.
const underAgent = (
  messages: SessionMessage[],
  toolUseId: string,
  agentId: string | null,
) =>
  messages.map((message) => ({
    ...message,
    parent_tool_use_id: toolUseId,
    parent_agent_id: agentId,
  }));

const AGENTS: SubagentRecord[] = [
  {
    agentId: "a2",
    toolUseId: "toolu-2",
    description: null,
    agentType: null,
    depth: 2,
    messages: underAgent(
      [
        prompt("i1", "count the lines", "2026-09-27T00:00:02.000Z"),
        reply("i2", "m4", text("12"), "end_turn"),
      ],
      "toolu-2",
      "a1",
    ),
  },
  {
    agentId: "a1",
    toolUseId: "toolu-1",
    description: "read the README",
    agentType: "Explore",
    depth: 1,
    messages: underAgent(
      [
        prompt("o1", "read the README and summarize it", STARTED),
        reply(
          "o2",
          "m3",
          toolUse("toolu-2", "Agent", { prompt: "count" }),
          "tool_use",
        ),
        toolResult("o3", "toolu-2", "12"),
        reply("o4", "m5", text("a summary"), "end_turn"),
      ],
      "toolu-1",
      null,
    ),
  },
];
