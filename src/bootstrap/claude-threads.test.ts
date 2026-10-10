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
import { createCodexLink } from "../infra/codex/codex-link.ts";
import { createDelegationWatch } from "../infra/codex/delegations.ts";
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
    expect(store.get(WORKER_A)?.childThreadIds).toEqual([REVIEWER]);
    expect(sent).toContainEqual({
      id: REPLY_ID,
      error: {
        code: -32600,
        message: "this message comes from a child of another Claude thread",
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
    expect(store.parentOf(CODEX_WORKER)).toBeUndefined();
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

  test("lets a Claude parent coordinate workers and their Codex reviews after reopening the store", async () => {
    const { threads, store, sessions, calls, start, call } =
      await orchestration();
    try {
      start();
      await until(() => sessions.has(WORKER_A));
      const first = await call(WORKER_A, "create_thread", {
        prompt: "work",
        target: TARGET,
        model: MODEL,
      });
      const second = await call(WORKER_A, "create_thread", {
        prompt: "work",
        target: TARGET,
        model: MODEL,
      });
      expect(first).toMatchObject({
        outcome: "done",
        threadId: "child-1",
        model: MODEL,
      });
      expect(second).toMatchObject({
        outcome: "done",
        threadId: "child-2",
        model: MODEL,
      });
      await until(() => sessions.has("child-1") && sessions.has("child-2"));
      const review = await call("child-1", "create_thread", {
        prompt: "review",
        target: TARGET,
      });
      expect(review).toMatchObject({
        outcome: "done",
        threadId: "child-3",
        model: "gpt-fixture",
      });

      const sent = await call(WORKER_A, "send_message_to_thread", {
        threadId: "child-1",
        prompt: "continue",
      });
      expect(sent.outcome).toBe("done");
      expect(store.get("child-1")?.requesterThreadIds).toEqual([WORKER_A]);
      expect(store.get(WORKER_A)?.childThreadIds).toEqual([
        "child-1",
        "child-2",
      ]);
      expect(store.get("child-1")?.childThreadIds).toEqual(["child-3"]);

      const reopened = await openThreadStore(join(dir, "orchestration.json"));
      if (reopened.isErr()) return expect.unreachable(reopened.error.message);
      const requests: string[] = [];
      const restored = (threadId: string) =>
        createCodexLink({
          callerThreadId: threadId,
          codexHome: "/fixture/.codex",
          store: reopened.value,
          delegations: createDelegationWatch(reopened.value.claimChild),
          request: async (_method, params) => {
            requests.push((params as { tool: string }).tool);
            return Result.ok({ content: [] });
          },
        });
      const parent = restored(WORKER_A);
      const worker = restored("child-1");
      expect(
        (
          await parent.call("wait_threads", {
            targets: [{ threadId: "child-1" }, { threadId: "child-2" }],
            timeoutMs: 0,
          })
        ).isError,
      ).toBeFalsy();
      expect(
        (await worker.call("read_thread", { threadId: "child-3" })).isError,
      ).toBeFalsy();
      expect(
        (
          await worker.call("send_message_to_thread", {
            threadId: WORKER_A,
            prompt: "done",
          })
        ).isError,
      ).toBeFalsy();
      expect(
        (
          await worker.call("send_message_to_thread", {
            threadId: "child-2",
            prompt: "wrong worker",
          })
        ).isError,
      ).toBe(true);
      expect(
        (await restored("child-2").call("read_thread", { threadId: "child-3" }))
          .isError,
      ).toBe(true);
      expect(requests).toEqual([
        "wait_threads",
        "read_thread",
        "send_message_to_thread",
      ]);
      expect(
        calls.filter((entry) => entry.tool === "send_message_to_thread"),
      ).toHaveLength(1);
    } finally {
      threads.closeAll();
    }
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

const orchestration = async () => {
  const opened = await openThreadStore(join(dir, "orchestration.json"));
  if (opened.isErr()) return expect.unreachable(opened.error.message);
  const store = opened.value;
  const sessions = new Map<string, ReturnType<typeof fakeClaude>>();
  const calls: { tool: string; arguments: Record<string, unknown> }[] = [];
  let sequence = 0;
  let child = 0;
  const threads = connect(store, [], {
    listConversations: async () => Result.ok([]),
    startSession: async (settings) => {
      const claude = fakeClaude(SUBSCRIPTION);
      sessions.set(settings.threadId, claude);
      return startClaudeSession(settings, claude.runtime);
    },
    request: async (method, params) => {
      if (method === "model/list") return Result.ok(MODELS);
      if (method !== "mcpServer/tool/call") return Result.ok({});
      const entry = params as {
        threadId: string;
        tool: string;
        arguments: Record<string, unknown>;
      };
      calls.push(entry);
      const args = entry.arguments;
      const id =
        entry.tool === "create_thread"
          ? `child-${++child}`
          : String(args.threadId);
      threads.router.fromApp(
        Buffer.from(
          `${JSON.stringify({
            id: ++sequence,
            method: "turn/start",
            params: {
              threadId: id,
              model: args.model ?? store.get(id)?.model,
              effort: args.thinking,
              cwd: dir,
              input: [],
              toolOutput: {
                name: entry.tool,
                namespace: "codex_app",
                output: `<codex_delegation><source_thread_id>${entry.threadId}</source_thread_id><prompt>${args.prompt}</prompt></codex_delegation>`,
              },
            },
          })}\n`,
        ),
      );
      return Result.ok({
        content: [{ type: "text", text: JSON.stringify(PROVISIONAL) }],
      });
    },
  });
  return {
    threads,
    store,
    sessions,
    calls,
    start: () =>
      threads.router.fromApp(
        Buffer.from(`${JSON.stringify(turnOf(++sequence, "coordinate"))}\n`),
      ),
    call: async (
      threadId: string,
      tool: string,
      args: Record<string, unknown>,
    ) =>
      JSON.parse(
        await threads.callGateway.handle(
          JSON.stringify({ threadId, tool, arguments: args }),
        ),
      ),
  };
};

const connectWith = async (
  requests: { method: string; params: unknown }[],
  sent: Sent[],
  { listConversations }: Pick<ThreadsDeps, "listConversations">,
) => {
  const opened = await openThreadStore(join(dir, "threads.json"));
  if (opened.isErr()) return expect.unreachable(opened.error.message);
  return connect(opened.value, sent, {
    request: async (method, params) => {
      requests.push({ method, params });
      return Result.ok({});
    },
    startSession: async () => expect.unreachable("Claude never starts"),
    listConversations,
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
  const threads = connect(store, sent, {
    request,
    startSession: async (session) => {
      settings.push(session);
      return startClaudeSession(session, claude.runtime);
    },
    listConversations: async () => Result.ok([]),
  });
  const fromApp = (message: object) =>
    threads.router.fromApp(Buffer.from(`${JSON.stringify(message)}\n`));
  fromApp(turnOf(1, "work"));
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

type ThreadsDeps = Parameters<typeof connectClaudeThreads>[0];

const connect = (
  store: ThreadsDeps["store"],
  sent: Sent[],
  deps: Pick<ThreadsDeps, "request" | "startSession" | "listConversations">,
) => {
  const catalog = createModelCatalog();
  return connectClaudeThreads({
    store,
    findSession: async () => Result.ok(true),
    lastRecordOf: async () => Result.ok(null),
    resolveConnection: async () => Result.ok(SUBSCRIPTION_CONNECTION),
    readSession: async () => Result.ok([]),
    readSubagents: async () => Result.ok([]),
    effortRule: effortRule({}, catalog.effortsOf),
    claudeModels: catalog.models,
    unverifiedCodex: "warn",
    codexHome: "/fixture/.codex",
    send: (message) => sent.push(message),
    log: () => {},
    ...deps,
  });
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
