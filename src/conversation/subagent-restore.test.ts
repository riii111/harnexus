import { describe, expect, test } from "bun:test";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { Result, TaggedError } from "better-result";
import type { SubagentRecord } from "../infra/claude/session.ts";
import type { HistoryTurn } from "../presentation/history.ts";
import {
  prompt,
  reply,
  text,
  toolResult,
  toolUse,
} from "../presentation/testing/session-record.ts";
import { createHistoryRequests } from "./history-request.ts";
import { createSubagentRestore } from "./subagent-restore.ts";
import { createSubagents, type Subagents } from "./subagents.ts";

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

  test("shows each call that resumed an agent as that agent's activity where the call was made", async () => {
    const { history, subagents } = setup(() => Result.ok([RESUMED_AGENT]), {
      parent: RESUMING_PARENT,
    });

    const parentHistory = (await history.load(THREAD)).unwrap();

    const [agent] = subagents.childrenOf(THREAD);
    expect(agent).toMatchObject({
      calls: ["toolu-1", "toolu-resume", "toolu-named"],
      toolUseId: "toolu-named",
      runs: 3,
    });
    expect(activityIds(parentHistory)).toEqual([
      `${agent?.id}-started-toolu-1`,
      `${agent?.id}-completed-toolu-1`,
      `${agent?.id}-started-toolu-resume`,
      `${agent?.id}-completed-toolu-resume`,
      `${agent?.id}-started-toolu-named`,
      `${agent?.id}-completed-toolu-named`,
    ]);
  });

  test("lets a fault in rebuilding agents through, and reads them again on the next load", async () => {
    let faults = 1;
    const { history, subagents, events } = setup(() => Result.ok(AGENTS), {
      restoreInto: (registry) => ({
        restore: (agents) => {
          if (faults > 0) {
            faults -= 1;
            // biome-ignore lint/plugin/no-throw-try-catch: a fault in the bridge throws.
            throw new Error("broken invariant");
          }
          registry.restore(agents);
        },
      }),
    });

    const failed = await history.load(THREAD).then(
      () => "loaded",
      (cause: unknown) => (cause instanceof Error ? cause.message : "rejected"),
    );
    const parentHistory = await history.load(THREAD);

    expect(failed).toBe("broken invariant");
    expect(events).toEqual([]);
    expect(parentHistory.isOk()).toBe(true);
    expect(subagents.childrenOf(THREAD)).toHaveLength(1);
  });

  test("leaves out an agent whose id or starting call an earlier agent has", async () => {
    const outer = AGENTS[1] as SubagentRecord;
    const { history, subagents } = setup(() =>
      Result.ok([
        outer,
        { ...outer, agentId: "a8" },
        { ...outer, toolUseId: "toolu-8" },
      ]),
    );

    await history.load(THREAD);

    expect(subagents.childrenOf(THREAD).map((child) => child.taskId)).toEqual([
      "a1",
    ]);
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

const setup = (
  read: () => Result<SubagentRecord[], Unreadable>,
  {
    parent = PARENT,
    restoreInto,
  }: {
    parent?: SessionMessage[];
    restoreInto?: (subagents: Subagents) => Pick<Subagents, "restore">;
  } = {},
) => {
  const subagents = createSubagents({ send: () => {} });
  const events: object[] = [];
  const restore = createSubagentRestore({
    subagents: restoreInto?.(subagents) ?? subagents,
    readSubagents: async () => read(),
    log: (event) => events.push(event),
  });
  const history = createHistoryRequests({
    threads: {
      threadOf: () => ({ model: "claude-sonnet-5", cwd: "/fixture/work" }),
      sessionIdOf: () => "se-1",
      takePicked: () => false,
    },
    readSession: async () => Result.ok(parent),
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
    name: null,
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
    name: "reader",
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

const activityIds = (history: readonly HistoryTurn[]) =>
  history
    .flatMap((turn) => turn.items.map(({ item }) => item))
    .filter((item) => item.type === "subAgentActivity")
    .map((item) => item.id);

// Claude answers a SendMessage call with one line of JSON, naming an agent it resumed as resumedAgentId.
const answer = (fields: object) => JSON.stringify({ success: true, ...fields });

// The agent is started, resumed by its id and then by its name with the reference Claude listed; a message to it while it ran was only queued, and one to an agent Claude does not know resumed nothing here.
const RESUMING_PARENT: SessionMessage[] = [
  prompt("p1", "summarize the README", "2026-09-27T00:00:00.000Z"),
  reply(
    "p2",
    "m1",
    toolUse("toolu-1", "Agent", { prompt: "read", name: "reader" }),
    "tool_use",
    "2026-09-27T00:00:00.500Z",
  ),
  toolResult("p3", "toolu-1", "a summary"),
  reply(
    "p4",
    "m2",
    toolUse("toolu-queued", "SendMessage", { to: "a1", message: "faster" }),
    "tool_use",
    "2026-09-27T00:00:02.000Z",
  ),
  toolResult(
    "p5",
    "toolu-queued",
    answer({
      message: "Message queued for delivery to reader at its next tool round.",
    }),
  ),
  prompt("p6", "now the license", "2026-09-27T00:01:00.000Z"),
  reply(
    "p7",
    "m3",
    toolUse("toolu-resume", "SendMessage", { to: "a1", message: "license" }),
    "tool_use",
    "2026-09-27T00:01:01.000Z",
  ),
  toolResult(
    "p8",
    "toolu-resume",
    answer({ message: "Resuming agent reader", resumedAgentId: "a1" }),
  ),
  reply(
    "p9",
    "m4",
    toolUse("toolu-named", "SendMessage", {
      to: "reader [r1]",
      message: "and the changelog",
    }),
    "tool_use",
    "2026-09-27T00:02:00.000Z",
  ),
  toolResult(
    "p10",
    "toolu-named",
    `${answer({ message: "Resumed agent. Its final report follows this JSON, framed by the harness." })}\nthe changelog`,
  ),
  reply(
    "p11",
    "m5",
    toolUse("toolu-stranger", "SendMessage", { to: "nobody", message: "hi" }),
    "tool_use",
    "2026-09-27T00:03:00.000Z",
  ),
  toolResult(
    "p12",
    "toolu-stranger",
    answer({ message: "Resuming agent nobody", resumedAgentId: "a9" }),
  ),
];

const RESUMED_AGENT: SubagentRecord = {
  ...(AGENTS[1] as SubagentRecord),
  messages: underAgent(
    [
      prompt("o1", "read the README and summarize it", STARTED),
      reply("o2", "m6", text("a summary"), "end_turn"),
      prompt("o3", "license", "2026-09-27T00:01:02.000Z"),
      reply("o4", "m7", text("MIT"), "end_turn"),
      prompt("o5", "and the changelog", "2026-09-27T00:02:01.000Z"),
      reply("o6", "m8", text("the changelog"), "end_turn"),
    ],
    "toolu-1",
    null,
  ),
};
