import { describe, expect, test } from "bun:test";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { type InferErr, Result } from "better-result";
import { readClaudeSession } from "../infra/claude/session.ts";
import type { ServerRequest } from "../infra/codex/server-requests.ts";
import type { RewindPoint } from "../infra/thread-store.ts";
import { prompt, reply, text } from "../presentation/testing/session-record.ts";
import { createSideChats, type ForkPoint, type Opened } from "./side-chat.ts";
import type { SideChatContext } from "./thread-values.ts";

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

    sideChats.remember(
      "th-side",
      claudeSide(await pointOf(sideChats), "gpt-fixture"),
    );
    await sideChats.beforeTurn("th-side", undefined);

    const brief = briefText(injects);
    expect(brief).toContain("first answer");
    expect(brief).not.toContain("second question");
  });

  test.each([
    {
      name: "a main conversation rewound to its start",
      env: () => {
        const env = setup();
        env.rewinds.set("th-main", { sessionId: "session-main", at: null });
        return env;
      },
    },
    {
      name: "a main thread with no Claude conversation yet",
      env: () => setup({ sessions: {} }),
    },
  ])("names no point for $name", async ({ env }) => {
    const { sideChats } = env();

    const point = await sideChats.pointOf("th-main", MAIN);

    expect(point.isOk() && point.value).toBeNull();
  });
});

describe("createSideChats.beforeTurn", () => {
  test("hands the conversation up to the fork to the Codex side chat before releasing it from Claude", async () => {
    const { sideChats, injects, dropped, record } = setup();
    const point = await sideChats.pointOf("th-main", MAIN);
    sideChats.remember(
      "th-side",
      claudeSide(point.isOk() ? point.value : null, undefined),
    );
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
    sideChats.remember(
      "th-side",
      claudeSide(await pointOf(sideChats), "gpt-fixture"),
    );

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
    sideChats.remember(
      "th-side",
      claudeSide(await pointOf(sideChats), undefined),
    );

    expect(sideChats.beforeTurn("th-side", model)).toBeNull();
    expect(injects).toEqual([]);
  });

  test("leaves a side chat whose Claude conversation began to the usual routing", async () => {
    const { sideChats, injects, begun } = setup();
    sideChats.remember(
      "th-side",
      claudeSide(await pointOf(sideChats), undefined),
    );
    begun.add("th-side");

    expect(sideChats.beforeTurn("th-side", "gpt-fixture")).toBeNull();
    expect(injects).toEqual([]);
  });

  test("releases a side chat of a main thread with no conversation without handing anything over", async () => {
    const { sideChats, injects, dropped } = setup();
    sideChats.remember("th-side", claudeSide(null, undefined));

    const refusal = await sideChats.beforeTurn("th-side", "gpt-fixture");

    expect(refusal).toBeNull();
    expect(injects).toEqual([]);
    expect(dropped).toEqual(["th-side"]);
  });

  test("keeps the side chat as it was after a rejected hand-over, so the message can be sent again", async () => {
    const { sideChats, injects, dropped, results } = setup();
    sideChats.remember(
      "th-side",
      claudeSide(await pointOf(sideChats), undefined),
    );
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
    sideChats.remember(
      "th-side",
      claudeSide(await pointOf(sideChats), undefined),
    );
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
    sideChats.remember(
      "th-side",
      claudeSide(await pointOf(sideChats), undefined),
    );
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
    sideChats.remember(
      "th-side",
      claudeSide(await pointOf(sideChats), undefined),
    );

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
    sideChats.remember(
      "th-side",
      claudeSide(await pointOf(sideChats), undefined),
    );

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

describe("createSideChats.referenceOf", () => {
  test("makes the reference from the main Codex thread's finished replies and what was asked in a running turn", async () => {
    const { sideChats, listed } = setup();

    const reference = await sideChats.referenceOf("th-main");

    const text = reference.isOk() ? (reference.value ?? "") : "";
    expect(text).toContain("The main thread runs on Codex.");
    expect(text).toContain("[user, turn 1]\ncodex question");
    expect(text).toContain("codex answer");
    expect(text).toContain("[user, turn 2]\nrunning question");
    expect(text).not.toContain("unfinished reply");
    expect(text).not.toContain("were read");
    expect(listed).toEqual([{ limit: 50, sortDirection: "desc" }]);
  });

  test("adds the oldest turn ahead of the newest page and says the turns between were not read", async () => {
    const { sideChats, main, listed } = setup();
    main.desc = page([RUNNING_TURN], "cursor");
    main.asc = page([FINISHED_TURN], "cursor");

    const reference = await sideChats.referenceOf("th-main");

    const text = reference.isOk() ? (reference.value ?? "") : "";
    expect(text).toContain("[user, turn 1]\ncodex question");
    expect(text).toContain("[user, turn 2]\nrunning question");
    expect(text).toContain(
      "Only the main thread's oldest turn (turn 1) and its newest turns (from turn 2) were read",
    );
    expect(listed).toEqual([
      { limit: 50, sortDirection: "desc" },
      { limit: 1, sortDirection: "asc" },
    ]);
  });

  test("takes a turn both pages hold from the newest page once", async () => {
    const { sideChats, main } = setup();
    main.desc = page([RUNNING_TURN, FINISHED_TURN], "cursor");
    main.asc = page(
      [{ ...FINISHED_TURN, items: [...FINISHED_TURN.items, STALE_REPLY] }],
      "cursor",
    );

    const reference = await sideChats.referenceOf("th-main");

    const text = reference.isOk() ? (reference.value ?? "") : "";
    expect(text.match(/codex question/g)).toHaveLength(1);
    expect(text).not.toContain("stale reply");
    expect(text).not.toContain("were read");
  });

  test("passes over inputs other than text in a user message", async () => {
    const { sideChats, main } = setup();
    main.desc = page(
      [
        {
          id: "turn-1",
          status: "completed",
          items: [
            {
              type: "userMessage",
              content: [
                { type: "image", url: "file:///fixture.png" },
                { type: "text", text: "about the image" },
              ],
            },
          ],
        },
      ],
      null,
    );

    const reference = await sideChats.referenceOf("th-main");

    expect(reference.isOk() && reference.value).toContain("about the image");
  });

  test("makes no reference from a main thread with no turns", async () => {
    const { sideChats, main } = setup();
    main.desc = page([], null);

    const reference = await sideChats.referenceOf("th-main");

    expect(reference.isOk() && reference.value).toBeNull();
  });

  test.each([
    { name: "a refused newest page", desc: "refused", asc: page([], null) },
    { name: "a newest answer that is no page", desc: {}, asc: page([], null) },
    {
      name: "a refused oldest page",
      desc: page([RUNNING_TURN], "cursor"),
      asc: "refused",
    },
    {
      name: "an oldest page with no turn though more were said to exist",
      desc: page([RUNNING_TURN], "cursor"),
      asc: page([], null),
    },
  ])("fails rather than hand over an empty or mixed conversation on $name", async ({
    desc,
    asc,
  }) => {
    const { sideChats, main } = setup();
    main.desc = desc;
    main.asc = asc;

    const reference = await sideChats.referenceOf("th-main");

    expect(reference.isErr()).toBe(true);
  });
});

describe("createSideChats.remember", () => {
  test("keeps the app's instructions and the reference for a side chat Claude may run", async () => {
    const { sideChats, noted } = setup({ claudeSides: [] });

    sideChats.remember("th-side", codexSide("the reference", undefined));

    expect(noted.get("th-side")).toEqual({
      instructions: INSTRUCTIONS,
      reference: "the reference",
    });
  });
});

describe("createSideChats.beforeTurn on a side chat of a Codex thread", () => {
  test("leaves a message picking Claude to the usual routing, which runs it on Claude", () => {
    const { sideChats } = setup({ claudeSides: [] });
    sideChats.remember("th-side", codexSide("the reference", undefined));

    expect(sideChats.beforeTurn("th-side", "claude-fixture")).toBeNull();
  });

  test("keeps a side chat that sent a message to Codex from moving to Claude", async () => {
    const { sideChats } = setup({ claudeSides: [] });
    sideChats.remember("th-side", codexSide("the reference", undefined));

    const first = sideChats.beforeTurn("th-side", undefined);
    const switched = await sideChats.beforeTurn("th-side", "claude-fixture");
    const picked = sideChats.beforeSettings("th-side", "claude-fixture");

    expect(first).toBeNull();
    expect(switched).toBe("side_chat_model_fixed");
    expect(picked).toBe("side_chat_model_fixed");
  });

  test("keeps a side chat whose main thread could not be read on Codex", async () => {
    const { sideChats } = setup({ claudeSides: [] });
    sideChats.remember("th-side", {
      parent: { agent: "Codex", unread: true },
      instructions: INSTRUCTIONS,
      model: undefined,
    });

    const switched = await sideChats.beforeTurn("th-side", "claude-fixture");
    const stayed = sideChats.beforeTurn("th-side", "gpt-fixture");

    expect(switched).toBe("side_chat_main_unread");
    expect(stayed).toBeNull();
  });

  test("returns a side chat Claude took up before its first message to the server when Codex is picked again", () => {
    const { sideChats, dropped } = setup({ claudeSides: ["th-side"] });
    sideChats.remember("th-side", codexSide("the reference", "claude-fixture"));

    const picked = sideChats.beforeSettings("th-side", "gpt-fixture");
    const sent = sideChats.beforeTurn("th-side", undefined);

    expect(picked).toBe("pass");
    expect(dropped).toEqual(["th-side"]);
    expect(sent).toBeNull();
  });
});

describe("createSideChats.beforeTurn on a side chat of a Claude thread", () => {
  test("keeps a side chat that moved to Codex from moving back to Claude", async () => {
    const { sideChats } = setup();
    sideChats.remember(
      "th-side",
      claudeSide(await pointOf(sideChats), undefined),
    );

    const moved = await sideChats.beforeTurn("th-side", "gpt-fixture");
    const back = await sideChats.beforeTurn("th-side", "claude-fixture");

    expect(moved).toBeNull();
    expect(back).toBe("side_chat_model_fixed");
  });

  test("keeps a side chat whose main conversation could not be read on Claude", async () => {
    const { sideChats, injects } = setup();
    sideChats.remember("th-side", {
      parent: { agent: "Claude", unread: true },
      instructions: INSTRUCTIONS,
      model: undefined,
    });

    const moved = await sideChats.beforeTurn("th-side", "gpt-fixture");
    const stayed = sideChats.beforeTurn("th-side", undefined);

    expect(moved).toBe("side_chat_main_unread");
    expect(stayed).toBeNull();
    expect(injects).toEqual([]);
  });
});

type Injected = Awaited<ReturnType<ServerRequest>>;

const setup = ({
  sessions = { "th-main": "session-main" } as Record<string, string>,
  claudeSides = ["th-side"],
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
  const claudeThreads = new Set(claudeSides);
  const noted = new Map<string, SideChatContext>();
  const main: { desc: unknown; asc: unknown } = {
    desc: page([RUNNING_TURN, FINISHED_TURN], null),
    asc: page([FINISHED_TURN], null),
  };
  const listed: object[] = [];
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
    listTurns: async (_threadId, request) => {
      listed.push(request);
      const answer = request.sortDirection === "desc" ? main.desc : main.asc;
      return answer === "refused" ? Result.err(REJECTED) : Result.ok(answer);
    },
    inject: async (threadId, items) => {
      injects.push([threadId, items]);
      return results.shift() ?? Result.ok({});
    },
    isClaudeThread: (threadId) => claudeThreads.has(threadId),
    claudeBegun: (threadId) => begun.has(threadId),
    dropFork: (threadId) => {
      dropped.push(threadId);
      claudeThreads.delete(threadId);
    },
    noteSideChat: (threadId, context) => noted.set(threadId, context),
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
    claudeThreads,
    noted,
    main,
    listed,
  };
};

const pointOf = async (sideChats: ReturnType<typeof setup>["sideChats"]) => {
  const point = await sideChats.pointOf("th-main", MAIN);
  return point.isOk() ? point.value : null;
};

const claudeSide = (point: ForkPoint, model: string | undefined): Opened => ({
  parent: { agent: "Claude", point },
  instructions: null,
  model,
});

const codexSide = (
  reference: string | null,
  model: string | undefined,
): Opened => ({
  parent: { agent: "Codex", reference },
  instructions: INSTRUCTIONS,
  model,
});

const INSTRUCTIONS = "You are in a side conversation, not the main thread.";

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

const page = (data: object[], nextCursor: string | null) => ({
  data,
  nextCursor,
  backwardsCursor: null,
});

const FINISHED_TURN = {
  id: "turn-1",
  status: "completed",
  items: [
    {
      type: "userMessage",
      content: [{ type: "text", text: "codex question" }],
    },
    { type: "reasoning", summary: [], content: [] },
    { type: "agentMessage", text: "codex answer", phase: "final_answer" },
  ],
};

// A turn still running when the side chat opened.
const RUNNING_TURN = {
  id: "turn-2",
  status: "inProgress",
  items: [
    {
      type: "userMessage",
      content: [{ type: "text", text: "running question" }],
    },
    { type: "agentMessage", text: "unfinished reply", phase: "commentary" },
  ],
};

const STALE_REPLY = {
  type: "agentMessage",
  text: "stale reply",
  phase: "final_answer",
};
