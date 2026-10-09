import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Result } from "better-result";
import { SUBSCRIPTION_CONNECTION } from "../infra/claude/connection.ts";
import { createModelCatalog, effortRule } from "../infra/claude/models.ts";
import {
  type ClaudeSessionSettings,
  startClaudeSession,
} from "../infra/claude/session.ts";
import { fakeClaude } from "../infra/claude/testing/fake-claude.ts";
import type { ServerRequest } from "../infra/codex/server-requests.ts";
import { openThreadStore } from "../infra/thread-store.ts";
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

  test("refuses the first turn of a thread a Codex thread created through the socket on another model", async () => {
    const { store, sent, callAfter } = await workerA();

    const { answer, routed } = await callAfter([codexWorkerFirstTurn()], {
      threadId: CODEX_CALLER,
      tool: "create_thread",
      arguments: {
        prompt: "work",
        target: TARGET,
        model: "gpt-worker",
        thinking: "low",
      },
    });

    expect(answer).toEqual({
      outcome: "model_mismatch",
      threadId: CODEX_WORKER,
      expected: { model: "gpt-worker", effort: "low" },
      actual: { model: "gpt-other", effort: "low" },
    });
    expect(routed).toEqual([null]);
    expect(sent).toContainEqual({
      id: 4,
      error: { code: -32600, message: expect.stringContaining("not run") },
    });
    expect(store.reviewerOwner(CODEX_WORKER)).toBeUndefined();
  });

  test("answers a Claude first turn the bridge refused with its reason instead of done", async () => {
    const { sent, callAfter } = await workerA();

    const { answer, routed } = await callAfter([claudeWorkerFirstTurn()], {
      threadId: CODEX_CALLER,
      tool: "create_thread",
      arguments: { prompt: "work", target: TARGET, model: MODEL },
    });

    expect(answer).toEqual({
      outcome: "first_turn_refused",
      threadId: CLAUDE_WORKER,
      reason: "directory_unknown",
    });
    expect(routed).toEqual([null]);
    expect(sent).toContainEqual({ id: 5, error: expect.anything() });
  });

  test("starts a Claude thread's session with the thread it runs", async () => {
    const { started, settingsOf } = await workerA();

    await started();

    expect(settingsOf()?.threadId).toBe(WORKER_A);
  });

  test("asks the server to keep a Claude thread on disk when its first turn runs", async () => {
    const { requests, started } = await workerA();

    await started();

    expect(requests).toContainEqual({
      method: "thread/inject_items",
      params: {
        threadId: WORKER_A,
        items: [
          expect.objectContaining({ type: "message", role: "developer" }),
        ],
      },
    });
  });

  test("asks the server to rename a thread after the conversation picked with /resume", async () => {
    const requests: { method: string; params: unknown }[] = [];
    const sent: Sent[] = [];
    const threads = await connectWith(requests, sent, {
      listConversations: async () => Result.ok([PICKABLE]),
    });
    const fromApp = (message: object) =>
      threads.router.fromApp(Buffer.from(`${JSON.stringify(message)}\n`));

    fromApp(turnOf(1, "/resume"));
    await until(() => question(sent) !== undefined);
    fromApp({
      id: question(sent).id,
      result: { answers: { conversation: { answers: ["Fixture title"] } } },
    });
    await until(() => requests.some((r) => r.method === "thread/name/set"));
    threads.closeAll();

    expect(requests).toContainEqual({
      method: "thread/name/set",
      params: { threadId: WORKER_A, name: "Fixture title" },
    });
  });
});

const connectWith = async (
  requests: { method: string; params: unknown }[],
  sent: Sent[],
  {
    listConversations,
  }: Pick<Parameters<typeof connectClaudeThreads>[0], "listConversations">,
) => {
  const opened = await openThreadStore(join(dir, "threads.json"));
  if (opened.isErr()) return expect.unreachable(opened.error.message);
  const catalog = createModelCatalog();
  return connectClaudeThreads({
    store: opened.value,
    request: async (method, params) => {
      requests.push({ method, params });
      return Result.ok({});
    },
    startSession: async () => expect.unreachable("Claude never starts"),
    findSession: async () => Result.ok(true),
    listConversations,
    lastRecordOf: async () => Result.ok(null),
    resolveConnection: async () => Result.ok(SUBSCRIPTION_CONNECTION),
    readSession: async () => Result.ok([]),
    readSubagents: async () => Result.ok([]),
    effortRule: effortRule({}, catalog.effortsOf),
    claudeModels: catalog.models,
    unverifiedCodex: "warn",
    send: (message) => sent.push(message),
    log: () => {},
  });
};

const question = (sent: Sent[]) =>
  sent.find((message) => message.method === "item/tool/requestUserInput");

const turnOf = (id: number, text: string) => ({
  id,
  method: "turn/start",
  params: {
    threadId: WORKER_A,
    model: MODEL,
    cwd: dir,
    input: [{ type: "text", text, text_elements: [] }],
  },
});

const workerA = async () => {
  const opened = await openThreadStore(join(dir, "threads.json"));
  if (opened.isErr()) return expect.unreachable(opened.error.message);
  const store = opened.value;
  const claude = fakeClaude(SUBSCRIPTION);
  const settings: ClaudeSessionSettings[] = [];
  const sent: Sent[] = [];
  let linesBeforeAnswer: object[] = [];
  const routed: (Buffer | null)[] = [];
  const requests: { method: string; params: unknown }[] = [];
  const request: ServerRequest = async (method, params) => {
    requests.push({ method, params });
    if (method === "model/list") return Result.ok(MODELS);
    if (method === "thread/inject_items") return Result.ok({});
    for (const line of linesBeforeAnswer) routed.push(fromApp(line));
    return Result.ok({
      content: [{ type: "text", text: JSON.stringify(PROVISIONAL) }],
    });
  };
  const catalog = createModelCatalog();
  const threads = connectClaudeThreads({
    store,
    request,
    startSession: async (session) => {
      settings.push(session);
      return startClaudeSession(session, claude.runtime);
    },
    findSession: async () => Result.ok(true),
    listConversations: async () => Result.ok([]),
    lastRecordOf: async () => Result.ok(null),
    resolveConnection: async () => Result.ok(SUBSCRIPTION_CONNECTION),
    readSession: async () => Result.ok([]),
    readSubagents: async () => Result.ok([]),
    effortRule: effortRule({}, catalog.effortsOf),
    claudeModels: catalog.models,
    unverifiedCodex: "warn",
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
    requests,
    started: async () => {
      await until(() => claude.started());
      threads.closeAll();
    },
    createThreadAfter,
    callAfter: async (lines: object[], call: object) => {
      linesBeforeAnswer = lines;
      const answer = await threads.callGateway.handle(JSON.stringify(call));
      threads.closeAll();
      return { answer: JSON.parse(answer), routed };
    },
    settingsOf: () => settings[0],
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

const codexWorkerFirstTurn = () => ({
  id: 4,
  method: "turn/start",
  params: {
    threadId: CODEX_WORKER,
    input: [],
    model: "gpt-other",
    effort: "low",
    toolOutput: {
      name: "create_thread",
      namespace: "codex_app",
      output: `<codex_delegation>\n  <source_thread_id>${CODEX_CALLER}</source_thread_id>\n  <prompt>work</prompt>\n</codex_delegation>`,
    },
  },
});

// No cwd, so the bridge cannot tell where the new Claude thread works and refuses its turn.
const claudeWorkerFirstTurn = () => ({
  id: 5,
  method: "turn/start",
  params: {
    threadId: CLAUDE_WORKER,
    input: [],
    model: MODEL,
    toolOutput: {
      name: "create_thread",
      namespace: "codex_app",
      output: `<codex_delegation>\n  <source_thread_id>${CODEX_CALLER}</source_thread_id>\n  <prompt>work</prompt>\n</codex_delegation>`,
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
const CODEX_CALLER = "th-fixture-codex-caller";
const CODEX_WORKER = "th-fixture-codex-worker";
const CLAUDE_WORKER = "th-fixture-claude-worker";
const MODEL = "claude-sonnet-5";
const SUBSCRIPTION: AccountInfo = {
  subscriptionType: "Claude Max",
  apiProvider: "firstParty",
};
const MODELS = {
  data: [{ id: "gpt-fixture", model: "gpt-fixture", isDefault: true }],
  nextCursor: null,
};
const PICKABLE = {
  sessionId: "se-fixture",
  worktree: null,
  name: "Fixture title",
  title: "Fixture title",
  updatedAtMs: 1_700_000_000_000,
  entrypoint: "cli",
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
