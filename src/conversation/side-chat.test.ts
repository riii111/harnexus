import { describe, expect, test } from "bun:test";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { type InferErr, Result } from "better-result";
import { readClaudeSession } from "../infra/claude/session.ts";
import type { ServerRequest } from "../infra/codex/server-requests.ts";
import type { RewindPoint } from "../infra/thread-store.ts";
import { prompt, reply, text } from "../presentation/testing/session-record.ts";
import { createSideChats } from "./side-chat.ts";

describe("createSideChats.pointOf", () => {
  test("fixes the side chat at the main conversation's last record", async () => {
    const { sideChats } = setup();

    const point = await sideChats.pointOf("th-main", MAIN);

    expect(point.isOk() && point.value).toEqual({
      sessionId: "session-main",
      at: "a2",
      model: MAIN.model,
      cwd: MAIN.cwd,
    });
  });

  test("fixes the side chat where a rewound main conversation stands rather than at its record's end", async () => {
    const { sideChats, injects, rewinds } = setup();
    rewinds.set("th-main", { sessionId: "session-main", at: "a1" });

    sideChats.remember("th-side", await pointOf(sideChats), "gpt-fixture");
    await sideChats.beforeTurn("th-side", undefined);

    const brief = briefText(injects);
    expect(brief).toContain("first answer");
    expect(brief).not.toContain("second question");
  });

  test("names no point for a main conversation rewound to its start", async () => {
    const { sideChats, rewinds } = setup();
    rewinds.set("th-main", { sessionId: "session-main", at: null });

    const point = await sideChats.pointOf("th-main", MAIN);

    expect(point.isOk() && point.value).toBeNull();
  });

  test("names no point for a main thread with no Claude conversation yet", async () => {
    const { sideChats } = setup({ sessions: {} });

    const point = await sideChats.pointOf("th-main", MAIN);

    expect(point.isOk() && point.value).toBeNull();
  });
});

describe("createSideChats.beforeTurn", () => {
  test("hands the conversation up to the fork to the Codex side chat before releasing it from Claude", async () => {
    const { sideChats, injects, dropped, record } = setup();
    const point = await sideChats.pointOf("th-main", MAIN);
    sideChats.remember("th-side", point.isOk() ? point.value : null, undefined);
    record.push(prompt("u3", "said after the fork"));

    const refusal = await sideChats.beforeTurn("th-side", "gpt-fixture");

    expect(refusal).toBeNull();
    expect(injects.map(([threadId]) => threadId)).toEqual(["th-side"]);
    const brief = briefText(injects);
    expect(brief).toContain("first question");
    expect(brief).toContain("first answer");
    expect(brief).not.toContain("said after the fork");
    expect(dropped).toEqual(["th-side"]);
    expect(sideChats.beforeTurn("th-side", "gpt-fixture")).toBeNull();
  });

  test("hands over a side chat opened on Codex even when its first message names no model", async () => {
    const { sideChats, injects } = setup();
    sideChats.remember("th-side", await pointOf(sideChats), "gpt-fixture");

    const refusal = await sideChats.beforeTurn("th-side", undefined);

    expect(refusal).toBeNull();
    expect(injects).toHaveLength(1);
  });

  test.each([
    { name: "no model", model: undefined },
    { name: "a Claude model", model: "claude-fixture" },
  ])("leaves a Claude side chat on Claude for a message naming $name", async ({
    model,
  }) => {
    const { sideChats, injects } = setup();
    sideChats.remember("th-side", await pointOf(sideChats), undefined);

    expect(sideChats.beforeTurn("th-side", model)).toBeNull();
    expect(injects).toEqual([]);
  });

  test("leaves a side chat whose Claude conversation began to the usual routing", async () => {
    const { sideChats, injects, begun } = setup();
    sideChats.remember("th-side", await pointOf(sideChats), undefined);
    begun.add("th-side");

    expect(sideChats.beforeTurn("th-side", "gpt-fixture")).toBeNull();
    expect(injects).toEqual([]);
  });

  test("releases a side chat of a main thread with no conversation without handing anything over", async () => {
    const { sideChats, injects, dropped } = setup();
    sideChats.remember("th-side", null, undefined);

    const refusal = await sideChats.beforeTurn("th-side", "gpt-fixture");

    expect(refusal).toBeNull();
    expect(injects).toEqual([]);
    expect(dropped).toEqual(["th-side"]);
  });

  test("keeps the side chat as it was after a rejected hand-over, so the message can be sent again", async () => {
    const { sideChats, injects, dropped, results } = setup();
    sideChats.remember("th-side", await pointOf(sideChats), undefined);
    results.push(Result.err(REJECTED));

    const refused = await sideChats.beforeTurn("th-side", "gpt-fixture");
    const retried = await sideChats.beforeTurn("th-side", "gpt-fixture");

    expect(refused).toBe("side_chat_not_briefed");
    expect(retried).toBeNull();
    expect(injects).toHaveLength(2);
    expect(dropped).toEqual(["th-side"]);
  });

  test("keeps the side chat as it was when the main record cannot be read, so the message can be sent again", async () => {
    const { sideChats, injects, dropped, reading } = setup();
    sideChats.remember("th-side", await pointOf(sideChats), undefined);
    reading.unreadable = true;

    const refused = await sideChats.beforeTurn("th-side", "gpt-fixture");
    reading.unreadable = false;
    const retried = await sideChats.beforeTurn("th-side", "gpt-fixture");

    expect(refused).toBe("side_chat_not_briefed");
    expect(retried).toBeNull();
    expect(injects).toHaveLength(1);
    expect(dropped).toEqual(["th-side"]);
  });

  test("stops a side chat whose hand-over has an unknown outcome instead of sending without it or twice", async () => {
    const { sideChats, injects, dropped, results } = setup();
    sideChats.remember("th-side", await pointOf(sideChats), undefined);
    results.push(Result.err(UNANSWERED));

    const first = await sideChats.beforeTurn("th-side", "gpt-fixture");
    const next = await sideChats.beforeTurn("th-side", undefined);

    expect(first).toBe("side_chat_stopped");
    expect(next).toBe("side_chat_stopped");
    expect(sideChats.beforeSettings("th-side", "claude-fixture")).toBe(
      "side_chat_stopped",
    );
    expect(sideChats.isStopped("th-side")).toBe(true);
    expect(injects).toHaveLength(1);
    expect(dropped).toEqual([]);
  });
});

describe("createSideChats.beforeSettings", () => {
  test("keeps a Codex model picked before the first message for that message", async () => {
    const { sideChats, injects } = setup();
    sideChats.remember("th-side", await pointOf(sideChats), undefined);

    const picked = sideChats.beforeSettings("th-side", "gpt-fixture");
    const shown = sideChats.showsCodex("th-side");
    const refusal = await sideChats.beforeTurn("th-side", undefined);

    expect(picked).toBe("pass");
    expect(shown).toBe(true);
    expect(refusal).toBeNull();
    expect(injects).toHaveLength(1);
  });

  test("leaves the side chat on Claude when Claude is picked again before the first message", async () => {
    const { sideChats, injects, dropped } = setup();
    sideChats.remember("th-side", await pointOf(sideChats), undefined);

    expect(sideChats.beforeSettings("th-side", "gpt-fixture")).toBe("pass");
    expect(sideChats.beforeSettings("th-side", "claude-fixture")).toBeNull();
    expect(sideChats.showsCodex("th-side")).toBe(false);
    expect(sideChats.beforeTurn("th-side", undefined)).toBeNull();
    expect(injects).toEqual([]);
    expect(dropped).toEqual([]);
  });

  test("leaves a thread that is no side chat to the usual routing", () => {
    const { sideChats } = setup();

    expect(sideChats.beforeSettings("th-other", "gpt-fixture")).toBeNull();
    expect(sideChats.beforeTurn("th-other", "gpt-fixture")).toBeNull();
  });
});

type Injected = Awaited<ReturnType<ServerRequest>>;

const setup = ({
  sessions = { "th-main": "session-main" } as Record<string, string>,
} = {}) => {
  const record: SessionMessage[] = [
    prompt("u1", "first question"),
    reply("a1", "m1", text("first answer"), "end_turn"),
    prompt("u2", "second question"),
    reply("a2", "m2", text("second answer"), "end_turn"),
  ];
  const injects: [string, object[]][] = [];
  const dropped: string[] = [];
  const begun = new Set<string>();
  const rewinds = new Map<string, RewindPoint>();
  const results: Injected[] = [];
  const reading = { unreadable: false };
  const sideChats = createSideChats({
    sessionIdOf: (threadId) => sessions[threadId] ?? null,
    rewindOf: (threadId) => rewinds.get(threadId),
    lastRecordOf: async () => Result.ok(record.at(-1)?.uuid ?? null),
    readSession: (sessionId) =>
      readClaudeSession(sessionId, {
        read: async () => {
          // biome-ignore lint/plugin/no-throw-try-catch: getSessionMessages rejects when the record cannot be read.
          if (reading.unreadable) throw new Error("unreadable");
          return [...record];
        },
      }),
    inject: async (threadId, items) => {
      injects.push([threadId, items]);
      return results.shift() ?? Result.ok({});
    },
    claudeBegun: (threadId) => begun.has(threadId),
    dropFork: (threadId) => dropped.push(threadId),
  });
  return {
    sideChats,
    injects,
    dropped,
    begun,
    rewinds,
    results,
    reading,
    record,
  };
};

const pointOf = async (sideChats: ReturnType<typeof setup>["sideChats"]) => {
  const point = await sideChats.pointOf("th-main", MAIN);
  return point.isOk() ? point.value : null;
};

const briefText = (injects: [string, object[]][]) =>
  JSON.stringify(injects[0]?.[1] ?? null);

const MAIN = { model: "claude-fixture", cwd: "/fixture/work" };

const REJECTED = {
  _tag: "ServerRequestRejected",
  method: "thread/inject_items",
  code: -32600,
  message: "rejected",
} as InferErr<Injected>;

const UNANSWERED = {
  _tag: "ServerRequestUnanswered",
  method: "thread/inject_items",
  message: "the server did not answer thread/inject_items within 30000ms",
} as InferErr<Injected>;
