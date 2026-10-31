import { describe, expect, test } from "bun:test";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { readClaudeSession } from "../infra/claude/session.ts";
import type { LiveTurn } from "../presentation/history.ts";
import {
  conversation,
  prompt,
  reply,
  text,
} from "../presentation/testing/session-record.ts";
import { createHistoryRequests, type HistoryEvent } from "./history-request.ts";
import { LIVE, statusOf } from "./testing/live-history.ts";

describe("createHistoryRequests.answer", () => {
  test("answers thread/items/list with the items of the asked turn, from past an item anchor, or from the start when the record lacks it", async () => {
    const { ask } = setup();

    const turn = await ask("thread/items/list", 8, {
      turnId: "harnexus-history-u2",
      sortDirection: "asc",
    });
    const [question, answer] = turn.result.data.map(
      (entry: { item: { id: string } }) => entry.item.id,
    );
    const afterQuestion = await ask("thread/items/list", 9, {
      turnId: "harnexus-history-u2",
      sortDirection: "asc",
      cursor: { type: "item", itemId: question },
    });
    const afterLiveAnchor = await ask("thread/items/list", 10, {
      turnId: "harnexus-history-u2",
      sortDirection: "asc",
      cursor: { type: "item", itemId: "live-turn-item-1" },
    });

    expect(turn.result.data).toMatchObject([
      { turnId: "harnexus-history-u2", item: { type: "userMessage" } },
      { turnId: "harnexus-history-u2", item: { type: "agentMessage" } },
    ]);
    expect(afterQuestion.result.data).toMatchObject([
      { item: { id: answer, type: "agentMessage" } },
    ]);
    expect(afterLiveAnchor.result.data).toMatchObject([
      { item: { id: question } },
      { item: { id: answer } },
    ]);
  });

  test("answers thread/timeline/list from the newest entry back", async () => {
    const { ask } = setup();

    const page = await ask("thread/timeline/list", 9, { limit: 1 });

    expect(page).toMatchObject({
      id: 9,
      result: {
        data: [{ type: "turnCompleted", turnId: "harnexus-history-u2" }],
        activeRealtimeSessionAtPageStart: null,
      },
    });
  });

  test("answers an empty history for a Claude thread that has no session yet", async () => {
    const { ask, reads } = setup({ records: {} });

    const page = await ask("thread/turns/list", 7, {});

    expect(reads).toEqual([]);
    expect(page).toEqual({
      id: 7,
      result: { data: [], nextCursor: null, backwardsCursor: null },
    });
  });

  test.each([
    {
      name: "an unreadable record",
      records: { "th-claude": "unreadable" as const },
      expected: -32603,
    },
    {
      name: "an unknown cursor",
      records: { "th-claude": conversation() },
      expected: -32602,
    },
  ])("answers a history page with error $expected for $name", async ({
    records,
    expected,
  }) => {
    const { ask } = setup({ records });

    const page = await ask("thread/turns/list", 7, { cursor: "server-cursor" });

    expect(page).toMatchObject({ id: 7, error: { code: expected } });
  });

  test("reads the record once for history pages asked for together and again for a later page", async () => {
    const records = { "th-claude": conversation() };
    const { ask, reads } = setup({ records });

    const together = await Promise.all([
      ask("thread/turns/list", 7, {}),
      ask("thread/turns/list", 8, {}),
    ]);
    records["th-claude"] = [
      ...conversation(),
      prompt("u3", "one more"),
      reply("a5", "m4", text("sure"), "end_turn"),
    ];
    const later = await ask("thread/turns/list", 9, {});

    expect(reads).toEqual(["session-th-claude", "session-th-claude"]);
    expect(together.map((page) => page.result.data.length)).toEqual([2, 2]);
    expect(later.result.data[0].id).toBe("harnexus-history-u3");
  });

  test.each([
    {
      name: "a turn Claude has recorded",
      turn: LIVE,
      turns: [
        ["harnexus-turn-live", "inProgress", true],
        ["harnexus-history-u1", "completed", false],
      ],
    },
    {
      name: "a turn Claude has not recorded yet",
      turn: { ...LIVE, record: null },
      turns: [
        ["harnexus-turn-live", "inProgress", true],
        ["harnexus-history-u2", "completed", false],
        ["harnexus-history-u1", "completed", false],
      ],
    },
  ])("lists $name as the newest turn, in progress", async ({ turn, turns }) => {
    const { ask, live } = setup();
    live.set("th-claude", turn);

    const page = await ask("thread/turns/list", 8, { sortDirection: "desc" });

    expect(page.result.data.map(statusOf)).toEqual(turns);
  });

  test("pages on from a cursor naming the live turn after it ends", async () => {
    const { ask, live, turnRecords } = setup();
    live.set("th-claude", LIVE);
    turnRecords.set(LIVE.turnId, "u2");

    const newest = await ask("thread/turns/list", 8, { limit: 1 });
    live.delete("th-claude");
    const older = await ask("thread/turns/list", 9, {
      limit: 1,
      cursor: newest.result.nextCursor,
    });
    const items = await ask("thread/items/list", 10, {
      limit: 1,
      turnId: LIVE.turnId,
    });

    expect(newest.result.data.map(statusOf)).toEqual([
      ["harnexus-turn-live", "inProgress", true],
    ]);
    expect(older.result.data.map(statusOf)).toEqual([
      ["harnexus-history-u1", "completed", false],
    ]);
    expect(items.result.data).toMatchObject([
      { turnId: "harnexus-history-u2", item: { type: "userMessage" } },
    ]);
  });

  test("logs which turns and items a history read named and returned, by the ids' kind and first characters", async () => {
    const { ask, live, events } = setup();
    const turnId = "harnexus-turn-0123abcd-4567-89ef-0123-456789abcdef";
    live.set("th-claude", { ...LIVE, turnId });

    await ask("thread/items/list", 8, {
      turnId,
      cursor: { type: "item", itemId: `${turnId}-item-2` },
    });

    expect(events).toContainEqual({
      event: "claude_history_answered",
      method: "thread/items/list",
      thread: "th-claud",
      live: "l:0123abcd",
      turn: "l:0123abcd",
      cursor: "anchor l:0123abcd-item-2",
      returned: ["harnexus-history-u2-item-1", "harnexus-history-u2-item-2"],
    });
  });
});

// A thread named in records has a session whose record holds those messages; "unreadable" makes reading it fail.
const setup = ({
  records = { "th-claude": conversation() },
}: {
  records?: Record<string, SessionMessage[] | "unreadable">;
} = {}) => {
  const sent: object[] = [];
  const reads: string[] = [];
  const events: HistoryEvent[] = [];
  const live = new Map<string, LiveTurn>();
  const turnRecords = new Map<string, string>();
  const history = createHistoryRequests({
    subagentHistory: () => undefined,
    subagents: { restore: async () => {}, agentRefOf: () => () => undefined },
    threads: {
      threadOf: () => ({ model: "claude-sonnet-5", cwd: "/fixture/work" }),
      sessionIdOf: (threadId) =>
        threadId in records ? `session-${threadId}` : null,
      rewindOf: () => undefined,
    },
    liveTurnOf: (threadId) => live.get(threadId) ?? null,
    recordOf: (_threadId, turnId) => turnRecords.get(turnId) ?? null,
    readSession: (sessionId) => {
      reads.push(sessionId);
      return readClaudeSession(sessionId, {
        read: async () => {
          const record = records[sessionId.replace("session-", "")];
          return record === undefined || record === "unreadable"
            ? Promise.reject(new Error("unreadable"))
            : record;
        },
      });
    },
    send: (message) => sent.push(message),
    log: (event) => events.push(event),
  });
  const ask = async (
    method: Parameters<typeof history.answer>[0],
    id: number,
    params: object,
  ) => {
    await history.answer(method, {
      id,
      params: { threadId: "th-claude", ...params },
    });
    return JSON.parse(
      JSON.stringify(
        sent.find((message) => "id" in message && message.id === id) ?? null,
      ),
    );
  };
  return { ask, sent, reads, events, live, turnRecords };
};
