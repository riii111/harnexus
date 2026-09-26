import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Result } from "better-result";
import { fakeClaude } from "../boundary/testing/fake-claude.ts";
import {
  type ClaudeSessionSettings,
  startClaudeSession,
} from "../claude/session.ts";
import type { ServerRequest } from "../rpc/server-requests.ts";
import { openThreadStore } from "../state/thread-store.ts";
import { connectClaudeThreads } from "./claude-threads.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-threads-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("connectClaudeThreads", () => {
  test("refuses a reviewer's reply to another worker when its first turn arrives before create_thread answers", async () => {
    const { store, sent, sessions, createThreadAfter } = await workerA();
    const registered = await store.register({
      threadId: WORKER_B,
      model: MODEL,
      worktree: join(dir, "b"),
    });
    expect(registered.isOk() && registered.value.threadId).toBe(WORKER_B);

    const created = await createThreadAfter([
      reviewerFirstTurn(),
      replyToWorkerB(),
    ]);

    expect(created.structuredContent).toEqual({ threadId: REVIEWER });
    expect(store.get(WORKER_A)?.reviewerThreadIds).toEqual([REVIEWER]);
    expect(sent).toContainEqual({
      id: REPLY_ID,
      error: {
        code: -32600,
        message: "this message comes from a reviewer of another Claude thread",
      },
    });
    expect(sessions()).toBe(1);
  });
});

const workerA = async () => {
  const opened = await openThreadStore(join(dir, "threads.json"));
  if (opened.isErr()) return expect.unreachable(opened.error.message);
  const store = opened.value;
  const claude = fakeClaude(SUBSCRIPTION);
  const settings: ClaudeSessionSettings[] = [];
  const sent: Sent[] = [];
  let linesBeforeAnswer: object[] = [];
  const request: ServerRequest = async (method) => {
    if (method === "model/list") return Result.ok(MODELS);
    for (const line of linesBeforeAnswer) fromApp(line);
    return Result.ok({
      content: [{ type: "text", text: JSON.stringify(PROVISIONAL) }],
    });
  };
  const threads = connectClaudeThreads({
    store,
    request,
    startSession: async (session) => {
      settings.push(session);
      return startClaudeSession(session, claude.runtime);
    },
    send: (message) => sent.push(message),
    log: () => {},
  });
  const fromApp = (message: object) =>
    threads.router.fromApp(Buffer.from(`${JSON.stringify(message)}\n`));
  fromApp(workerATurn());
  const createThreadAfter = async (lines: object[]) => {
    await until(() => claude.started());
    linesBeforeAnswer = lines;
    const client = await linkClient(settings[0]);
    const created = await client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: TARGET },
    });
    threads.closeAll();
    return created;
  };
  return {
    store,
    sent,
    createThreadAfter,
    sessions: () => settings.length,
  };
};

const linkClient = async (session: ClaudeSessionSettings | undefined) => {
  const link = session?.mcpServers?.codex_link;
  if (link?.type !== "sdk") return expect.unreachable("no thread tools");
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await link.instance.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return client;
};

const workerATurn = () => ({
  id: 1,
  method: "turn/start",
  params: {
    threadId: WORKER_A,
    model: MODEL,
    cwd: dir,
    input: [{ type: "text", text: "work", text_elements: [] }],
  },
});

const reviewerFirstTurn = () => ({
  id: 2,
  method: "turn/start",
  params: {
    threadId: REVIEWER,
    input: [],
    toolOutput: {
      name: "create_thread",
      namespace: "codex_app",
      output: `<codex_delegation>\n  <source_thread_id>${WORKER_A}</source_thread_id>\n  <prompt>review</prompt>\n</codex_delegation>`,
    },
  },
});

const replyToWorkerB = () => ({
  id: REPLY_ID,
  method: "turn/start",
  params: {
    threadId: WORKER_B,
    input: [],
    toolOutput: {
      name: "send_message_to_thread",
      namespace: "codex_app",
      output: `<codex_delegation>\n  <source_thread_id>${REVIEWER}</source_thread_id>\n  <input>done</input>\n</codex_delegation>`,
    },
  },
});

const until = async (condition: () => boolean) => {
  for (let waited = 0; !condition(); waited += 2) {
    if (waited > 2000) return expect.unreachable("condition never held");
    await Bun.sleep(2);
  }
};

// biome-ignore lint/suspicious/noExplicitAny: messages are checked by shape in each test.
type Sent = any;

const WORKER_A = "th-fixture-worker-a";
const WORKER_B = "th-fixture-worker-b";
const REVIEWER = "th-fixture-reviewer-a";
const REPLY_ID = 3;
const MODEL = "claude-sonnet-5";
const SUBSCRIPTION: AccountInfo = {
  subscriptionType: "Claude Max",
  apiProvider: "firstParty",
};
const MODELS = {
  data: [{ id: "gpt-fixture", model: "gpt-fixture", isDefault: true }],
  nextCursor: null,
};
const PROVISIONAL = {
  clientThreadId: "client-new-thread:019a0000-0000-7000-8000-0000000000cc",
  hostId: "local",
};
const TARGET = {
  type: "project",
  projectId: "project-1",
  environment: { type: "local" },
};
