import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk";
import { Result } from "better-result";

import {
  prompt,
  reply,
  text,
} from "../features/conversation/testing/session-record.ts";
import { createModelCatalog, effortRule } from "../infra/claude/models.ts";
import {
  type ClaudeSessionSettings,
  startClaudeSession,
} from "../infra/claude/session.ts";
import { fakeClaude } from "../infra/claude/testing/fake-claude.ts";
import type { ServerRequest } from "../infra/codex/server-requests.ts";
import { createMemoryCronRecord } from "../infra/codex/testing/cron-record.ts";
import { openSideChatStore, sideChatsPath } from "../infra/side-chat-store.ts";
import { createMemoryCloudLinks } from "../infra/testing/cloud-links.ts";
import { openThreadStore } from "../infra/thread-store.ts";
import { connectClaudeThreads } from "./bridge-wiring.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-side-chats-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("connectClaudeThreads with a saved side chat of a Claude thread", () => {
  test("hands the main conversation to Codex once, with the first message after a restart", async () => {
    const opening = await connect();
    await opening.router.fromApp(SAVED_FORK);
    await opening.router.fromServer(SIDE_CHAT_OPENED);
    await until(async () => (await opening.saved()) === 1);
    opening.closeAll();

    const restarted = await connect();
    const first = await restarted.router.fromApp(TURN_ON_CODEX);
    await until(async () => (await restarted.saved()) === 0);
    restarted.closeAll();
    const again = await connect();
    const next = await again.router.fromApp(TURN_ON_CODEX);
    again.closeAll();

    expect(restarted.injects.map(([threadId]) => threadId)).toEqual([
      "th-side",
    ]);
    expect(JSON.stringify(restarted.injects[0]?.[1])).toContain("first answer");
    expect(first).toBe(TURN_ON_CODEX);
    expect(next).toBe(TURN_ON_CODEX);
    expect(again.injects).toEqual([]);
  });

  test("starts the Claude conversation of a side chat that stays on Claude from the main conversation as it stood when it opened, after a restart", async () => {
    const opening = await connect();
    await opening.router.fromApp(SAVED_FORK);
    await opening.router.fromServer(SIDE_CHAT_OPENED);
    await until(async () => (await opening.saved()) === 1);
    opening.closeAll();

    const restarted = await connect();
    await restarted.router.fromApp(TURN_ON_CLAUDE);
    await until(async () => restarted.sessions.length > 0);
    restarted.closeAll();

    expect(restarted.sessions[0]).toMatchObject({
      resume: "session-main",
      forkSession: true,
      resumeAt: "a1",
      instructions: SIDE_CHAT_INSTRUCTIONS,
    });
  });

  test("keeps a side chat that stopped on an unknown hand-over stopped after a restart", async () => {
    const opening = await connect({ inject: unanswered() });
    await opening.router.fromApp(SAVED_FORK);
    await opening.router.fromServer(SIDE_CHAT_OPENED);
    await until(async () => (await opening.saved()) === 1);
    await opening.router.fromApp(TURN_ON_CODEX);
    opening.closeAll();

    const restarted = await connect();
    const refused = await restarted.router.fromApp(TURN_ON_CODEX);
    restarted.closeAll();

    expect(refused).toBeNull();
    expect(restarted.injects).toEqual([]);
    expect(restarted.sent).toContainEqual({
      id: 10,
      error: expect.objectContaining({
        message: expect.stringContaining("could not confirm"),
      }),
    });
  });
});

const connect = async ({
  inject = async () => Result.ok({}),
}: { inject?: ServerRequest } = {}) => {
  const store = (await openThreadStore(join(dir, "threads.json"))).unwrap();
  const sideChats = (await openSideChatStore(sideChatsPath(dir))).unwrap();
  if (store.get("th-main") === undefined) {
    await store.register({
      threadId: "th-main",
      model: MODEL,
      worktree: "/fixture/work",
    });
    await store.setSessionId("th-main", "session-main");
  }

  const injects: [string, object[]][] = [];
  const sent: object[] = [];
  const sessions: ClaudeSessionSettings[] = [];
  const claude = fakeClaude(SUBSCRIPTION);
  const catalog = createModelCatalog();
  const threads = connectClaudeThreads({
    store,
    sideChatStore: sideChats,
    cloudLinks: createMemoryCloudLinks(),
    request: async (method, params, options) => {
      if (method === "thread/inject_items") {
        const { threadId, items } = params as {
          threadId: string;
          items: object[];
        };
        injects.push([threadId, items]);
        return inject(method, params, options);
      }

      return Result.ok({});
    },
    startSession: async (session) => {
      sessions.push(session);
      return startClaudeSession(session, claude.runtime);
    },
    findSession: async () => Result.ok(true),
    listConversations: async () => Result.ok([]),
    lastRecordOf: async () => Result.ok(MAIN_RECORD.at(-1)?.uuid ?? null),
    readSession: async () => Result.ok([...MAIN_RECORD]),
    readSubagents: async () => Result.ok([]),
    effortRule: effortRule({}, catalog.effortsOf),
    claudeModels: catalog.models,
    codexHome: "/fixture/.codex",
    cronRecord: createMemoryCronRecord(),
    send: (message) => sent.push(message),
    log: () => {},
  });
  return {
    router: threads.router,
    closeAll: threads.closeAll,
    injects,
    sent,
    sessions,
    saved: async () =>
      (await openSideChatStore(sideChatsPath(dir))).unwrap().all().length,
  };
};

const unanswered = (): ServerRequest => async (method) =>
  Result.err({
    _tag: "ServerRequestUnanswered",
    method,
    message: `the server did not answer ${method} within 30000ms`,
  } as never);

// The file is read back, since the store follows a change in memory before its write ends.
const until = async (done: () => Promise<boolean>) => {
  for (let tries = 0; tries < 200 && !(await done()); tries++)
    await new Promise((resolve) => setTimeout(resolve, 5));
};

const line = (message: object) => Buffer.from(`${JSON.stringify(message)}\n`);

const MODEL = "claude-sonnet-5";

const SUBSCRIPTION: AccountInfo = {
  subscriptionType: "Claude Max",
  apiProvider: "firstParty",
};

const SIDE_CHAT_INSTRUCTIONS =
  "You are in a side conversation, not the main thread.";

const MAIN_RECORD = [
  prompt("u1", "first question"),
  reply("a1", "m1", text("first answer"), "end_turn"),
];

const SAVED_FORK = line({
  id: 9,
  method: "thread/fork",
  params: {
    threadId: "th-main",
    attachToSource: true,
    developerInstructions: SIDE_CHAT_INSTRUCTIONS,
  },
});

const SIDE_CHAT_OPENED = line({
  id: 9,
  result: {
    thread: { id: "th-side", model: "gpt-fixture", cwd: "/fixture/work" },
    model: "gpt-fixture",
    cwd: "/fixture/work",
  },
});

const TURN_ON_CODEX = line({
  id: 10,
  method: "turn/start",
  params: {
    threadId: "th-side",
    input: [{ type: "text", text: "what did I ask first?" }],
    model: "gpt-fixture",
  },
});

const TURN_ON_CLAUDE = line({
  id: 11,
  method: "turn/start",
  params: {
    threadId: "th-side",
    cwd: "/fixture/work",
    input: [{ type: "text", text: "what did I ask first?" }],
    model: MODEL,
  },
});
