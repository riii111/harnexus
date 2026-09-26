import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Result, TaggedError } from "better-result";
import { createDelegationWatch } from "../link/delegations.ts";
import type {
  ServerRequest,
  ServerRequestError,
} from "../rpc/server-requests.ts";
import { createCodexLink } from "./codex-link.ts";

describe("createCodexLink tools", () => {
  test("registers the five thread tools without a host choice", async () => {
    const { client } = await connect();

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "create_thread",
      "list_projects",
      "read_thread",
      "send_message_to_thread",
      "wait_threads",
    ]);
    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain(
        "hostId",
      );
    }
  });

  test("lets only the read tools run without asking", async () => {
    const { link } = await connect();

    expect(link.allowedTools).toEqual([
      "mcp__codex_link__list_projects",
      "mcp__codex_link__read_thread",
      "mcp__codex_link__wait_threads",
    ]);
  });

  test("calls the Codex app tool on behalf of the caller thread", async () => {
    const { client, requests } = await connect({
      answer: () => Result.ok(textAnswer("projects")),
    });

    const result = await client.callTool({
      name: "list_projects",
      arguments: {},
    });

    expect(result).toMatchObject({
      content: [{ type: "text", text: "projects" }],
    });
    expect(requests).toEqual([
      {
        method: "mcpServer/tool/call",
        params: {
          threadId: CALLER,
          server: "codex_app",
          tool: "list_projects",
          arguments: {},
        },
        timeoutMs: 60_000,
      },
    ]);
  });

  test("records a created thread as a reviewer and then allows messages to it", async () => {
    const { client, store, requests } = await connect({
      answer: (params) =>
        Result.ok(
          params.tool === "create_thread"
            ? textAnswer(JSON.stringify({ threadId: REVIEWER }))
            : textAnswer("sent"),
        ),
    });

    await client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: TARGET },
    });
    const sent = await client.callTool({
      name: "send_message_to_thread",
      arguments: { threadId: REVIEWER, prompt: "again" },
    });

    expect(store.reviewers(CALLER)).toEqual([REVIEWER]);
    expect(sent.isError).toBeFalsy();
    expect(requests.map((request) => request.params.arguments)).toEqual([
      { prompt: "review", target: TARGET, model: "gpt-fixture" },
      { threadId: REVIEWER, prompt: "again" },
    ]);
  });

  test("learns the created thread from the app's first turn on it when the answer has only a provisional id", async () => {
    const delegations = createDelegationWatch();
    const { client, store } = await connect({
      delegations,
      answer: (params) => {
        if (params.tool === "create_thread") {
          delegations.observe("thread-elsewhere", OTHER_REVIEWER);
          delegations.observe(CALLER, REVIEWER);
        }
        return Result.ok(textAnswer(JSON.stringify(PROVISIONAL)));
      },
    });

    const created = await client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: TARGET },
    });

    expect(store.reviewers(CALLER)).toEqual([REVIEWER]);
    expect(created.structuredContent).toEqual({ threadId: REVIEWER });
    expect(text(created)).toContain(REVIEWER);
  });

  test("refuses a Claude model for a reviewer without calling the app", async () => {
    const { client, requests, modelLists } = await connect();

    const created = await client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: TARGET, model: "claude-sonnet-5" },
    });

    expect(created.isError).toBe(true);
    expect(requests).toEqual([]);
    expect(modelLists).toEqual([]);
  });

  test("creates nothing when the app's default model cannot be read", async () => {
    const { client, link, requests } = await connect({
      models: () => Result.err(unanswered()),
    });

    const created = await client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: TARGET },
    });

    expect(created.isError).toBe(true);
    expect(requests).toEqual([]);
    expect(link.hasUnsettledWrite()).toBe(false);
  });

  test("reads later model pages until it finds the default Codex model", async () => {
    const { client, requests, modelLists } = await connect({
      models: (params) =>
        Result.ok(
          params.cursor === undefined
            ? {
                data: [{ model: "claude-sonnet-5", isDefault: true }],
                nextCursor: "page-2",
              }
            : {
                data: [{ model: "gpt-later", isDefault: true }],
                nextCursor: null,
              },
        ),
      answer: () =>
        Result.ok(textAnswer(JSON.stringify({ threadId: REVIEWER }))),
    });

    await client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: TARGET },
    });

    expect(modelLists).toEqual([{}, { cursor: "page-2" }]);
    expect(requests[0]?.params.arguments.model).toBe("gpt-later");
  });

  test("allows reading and waiting on its own thread but not messaging it", async () => {
    const { client, requests } = await connect({
      answer: () => Result.ok(textAnswer("ok")),
    });

    await client.callTool({
      name: "read_thread",
      arguments: { threadId: CALLER },
    });
    await client.callTool({
      name: "wait_threads",
      arguments: { targets: [{ threadId: CALLER }], timeoutMs: 1_000 },
    });
    const sent = await client.callTool({
      name: "send_message_to_thread",
      arguments: { threadId: CALLER, prompt: "note" },
    });

    expect(sent.isError).toBe(true);
    expect(requests.map((request) => request.timeoutMs)).toEqual([
      60_000, 31_000,
    ]);
  });

  test("never forwards a host choice, even nested in wait targets", async () => {
    const { client, requests } = await connect({
      answer: () => Result.ok(textAnswer("ok")),
    });

    await client.callTool({
      name: "wait_threads",
      arguments: { targets: [{ threadId: CALLER, hostId: "remote" }] },
    });

    expect(requests[0]?.params.arguments).toEqual({
      targets: [{ threadId: CALLER }],
    });
  });

  test("prefers a thread id in the structured answer", async () => {
    const { client, store } = await connect({
      caller: UUID_CALLER,
      answer: () =>
        Result.ok({
          ...textAnswer(`Created from ${OTHER_UUID}`),
          structuredContent: { threadId: REVIEWER },
        }),
    });

    await client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: TARGET },
    });

    expect(store.reviewers(UUID_CALLER)).toEqual([REVIEWER]);
  });

  test("does not take a provisional id for the created thread", async () => {
    const { client, link, store } = await connect({
      answer: () =>
        Result.ok(
          textAnswer(
            JSON.stringify({ clientThreadId: REVIEWER, status: "queued" }),
          ),
        ),
    });

    const created = await client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: TARGET },
    });

    expect(created.isError).toBe(true);
    expect(store.reviewers(CALLER)).toEqual([]);
    expect(link.hasUnsettledWrite()).toBe(true);
  });

  test("refuses a target outside the forms the app defines without calling it", async () => {
    const { client, requests } = await connect();

    const created = await client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: { type: "project", extra: 1 } },
    });

    expect(created.isError).toBe(true);
    expect(requests).toEqual([]);
  });
});

describe("createCodexLink target checks", () => {
  test("refuses every operation on another worker's reviewer without calling the app", async () => {
    const { client, requests } = await connect({
      reviewers: { [OTHER_WORKER]: [OTHER_REVIEWER] },
    });

    const results = [
      await client.callTool({
        name: "send_message_to_thread",
        arguments: { threadId: OTHER_REVIEWER, prompt: "hi" },
      }),
      await client.callTool({
        name: "read_thread",
        arguments: { threadId: OTHER_REVIEWER },
      }),
      await client.callTool({
        name: "wait_threads",
        arguments: {
          targets: [{ threadId: CALLER }, { threadId: OTHER_REVIEWER }],
        },
      }),
    ];

    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(OTHER_REVIEWER);
    }
    expect(requests).toEqual([]);
  });

  test("refuses everything for a caller that is not a registered Claude thread", async () => {
    const { client, requests } = await connect({ callerRegistered: false });

    const created = await client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: TARGET },
    });
    const listed = await client.callTool({
      name: "list_projects",
      arguments: {},
    });

    expect(created.isError).toBe(true);
    expect(listed.isError).toBe(true);
    expect(requests).toEqual([]);
  });
});

describe("createCodexLink write outcomes", () => {
  test("never sends again after a send whose answer was lost", async () => {
    const { client, link, requests } = await connect({
      reviewers: { [CALLER]: [REVIEWER] },
      answer: () => Result.err(unanswered()),
    });

    const first = await send(client);
    const second = await send(client);
    const created = await client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: TARGET },
    });

    expect(first.isError).toBe(true);
    expect(second.isError).toBe(true);
    expect(text(second)).toContain("unknown outcome");
    expect(created.isError).toBe(true);
    expect(requests).toHaveLength(1);
    expect(link.hasUnsettledWrite()).toBe(true);
  });

  test("still allows reads after an unknown outcome so the result can be checked", async () => {
    const { client, requests } = await connect({
      reviewers: { [CALLER]: [REVIEWER] },
      answer: (params) =>
        params.tool === "read_thread"
          ? Result.ok(textAnswer("turns"))
          : Result.err(rejected()),
    });

    await send(client);
    const read = await client.callTool({
      name: "read_thread",
      arguments: { threadId: REVIEWER },
    });

    expect(read.isError).toBeFalsy();
    expect(requests.map((request) => request.params.tool)).toEqual([
      "send_message_to_thread",
      "read_thread",
    ]);
  });

  test("treats an answer with an item missing its text as an unknown outcome", async () => {
    const { client, link } = await connect({
      reviewers: { [CALLER]: [REVIEWER] },
      answer: () => Result.ok({ content: [{ type: "text" }] }),
    });

    const sent = await send(client);

    expect(sent.isError).toBe(true);
    expect(link.hasUnsettledWrite()).toBe(true);
  });

  test("treats a malformed answer to a write as an unknown outcome", async () => {
    const { client, link } = await connect({
      reviewers: { [CALLER]: [REVIEWER] },
      answer: () => Result.ok({ unexpected: true }),
    });

    await send(client);

    expect(link.hasUnsettledWrite()).toBe(true);
  });

  test("lets a write that was never sent, or that the app refused, be tried again", async () => {
    let calls = 0;
    const { client, link, requests } = await connect({
      reviewers: { [CALLER]: [REVIEWER] },
      answer: () => {
        calls += 1;
        return calls === 1
          ? Result.err(notSent())
          : Result.ok({ ...textAnswer("no such thread"), isError: true });
      },
    });

    const first = await send(client);
    const second = await send(client);
    const third = await send(client);

    expect([first.isError, second.isError, third.isError]).toEqual([
      true,
      true,
      true,
    ]);
    expect(text(second)).toBe("no such thread");
    expect(requests).toHaveLength(3);
    expect(link.hasUnsettledWrite()).toBe(false);
  });

  test("stops writing when a created thread cannot be identified", async () => {
    const { client, link, store } = await connect({
      answer: () => Result.ok(textAnswer("Created two: a and b")),
    });

    const created = await client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: TARGET },
    });

    expect(created.isError).toBe(true);
    expect(store.reviewers(CALLER)).toEqual([]);
    expect(link.hasUnsettledWrite()).toBe(true);
  });

  test("stops writing when a created thread cannot be saved as a reviewer", async () => {
    const { client, link } = await connect({
      addReviewerFails: true,
      answer: () =>
        Result.ok(textAnswer(JSON.stringify({ threadId: REVIEWER }))),
    });

    const created = await client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: TARGET },
    });

    expect(created.isError).toBe(true);
    expect(text(created)).toContain(REVIEWER);
    expect(link.hasUnsettledWrite()).toBe(true);
  });

  test("holds a second write until the first is decided and drops it when that was lost", async () => {
    let release: (value: Result<unknown, ServerRequestError>) => void =
      () => {};
    const { client, requests } = await connect({
      reviewers: { [CALLER]: [REVIEWER] },
      answer: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });

    const first = send(client);
    const second = send(client);
    await waitUntil(() => requests.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toHaveLength(1);
    release(Result.err(unanswered()));

    expect((await first).isError).toBe(true);
    expect(text(await second)).toContain("unknown outcome");
    expect(requests).toHaveLength(1);
  });

  test("drops a write queued before the turn stopped without sending it", async () => {
    let release: (value: Result<unknown, ServerRequestError>) => void =
      () => {};
    const { client, link, requests } = await connect({
      reviewers: { [CALLER]: [REVIEWER] },
      answer: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const first = send(client);
    await waitUntil(() => requests.length === 1);
    const second = send(client);
    await new Promise((resolve) => setTimeout(resolve, 20));

    link.cancelQueuedWrites();
    release(Result.ok(textAnswer("sent")));
    await first;

    expect(text(await second)).toContain("stopped");
    expect(requests).toHaveLength(1);
    expect(link.hasUnsettledWrite()).toBe(false);
  });

  test("still sends a write made after the stop", async () => {
    const { client, link, requests } = await connect({
      reviewers: { [CALLER]: [REVIEWER] },
    });

    link.cancelQueuedWrites();
    const sent = await send(client);

    expect(sent.isError).toBeFalsy();
    expect(requests).toHaveLength(1);
  });

  test("reports a write still waiting for its answer as unsettled, as when a turn is stopped mid-call", async () => {
    let release: (value: Result<unknown, ServerRequestError>) => void =
      () => {};
    const { client, link, requests } = await connect({
      reviewers: { [CALLER]: [REVIEWER] },
      answer: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });

    const pending = send(client);
    await waitUntil(() => requests.length === 1);
    const whileWaiting = link.hasUnsettledWrite();
    release(Result.ok(textAnswer("sent")));
    await pending;

    expect(whileWaiting).toBe(true);
    expect(link.hasUnsettledWrite()).toBe(false);
  });
});

const connect = async ({
  caller = CALLER,
  reviewers = {},
  callerRegistered = true,
  addReviewerFails = false,
  delegations = createDelegationWatch(),
  models = () => Result.ok(DEFAULT_MODELS),
  answer = () => Result.ok(textAnswer("ok")),
}: {
  delegations?: ReturnType<typeof createDelegationWatch>;
  models?: (
    params: Record<string, unknown>,
  ) => Result<unknown, ServerRequestError>;
  caller?: string;
  reviewers?: Record<string, string[]>;
  callerRegistered?: boolean;
  addReviewerFails?: boolean;
  answer?: (
    params: CallParams,
  ) =>
    | Result<unknown, ServerRequestError>
    | Promise<Result<unknown, ServerRequestError>>;
} = {}) => {
  const store = fakeStore(
    callerRegistered ? { [caller]: [], ...reviewers } : reviewers,
    addReviewerFails,
  );
  const requests: RecordedRequest[] = [];
  const modelLists: unknown[] = [];
  const request: ServerRequest = async (method, params, { timeoutMs }) => {
    if (method === "model/list") {
      modelLists.push(params);
      return models(params as Record<string, unknown>);
    }
    const call = params as CallParams;
    requests.push({ method, params: call, timeoutMs });
    return answer(call);
  };
  const link = createCodexLink({
    callerThreadId: caller,
    store,
    request,
    delegations,
    createdThreadWaitMs: 20,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await link.server.instance.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return { client, link, store, requests, modelLists };
};

const fakeStore = (
  initial: Record<string, string[]>,
  addReviewerFails: boolean,
) => {
  const reviewers = new Map(Object.entries(initial));
  return {
    get: (threadId: string) => {
      const ids = reviewers.get(threadId);
      return ids === undefined ? undefined : { reviewerThreadIds: ids };
    },
    addReviewer: async (threadId: string, reviewerThreadId: string) => {
      if (addReviewerFails) return Result.err(new FakeSaveFailed());
      reviewers.set(threadId, [
        ...(reviewers.get(threadId) ?? []),
        reviewerThreadId,
      ]);
      return Result.ok(null);
    },
    reviewers: (threadId: string) => reviewers.get(threadId),
  };
};

class FakeSaveFailed extends TaggedError("FakeSaveFailed")<{
  message: string;
}> {
  constructor() {
    super({ message: "disk full" });
  }
}

const send = (client: Client) =>
  client.callTool({
    name: "send_message_to_thread",
    arguments: { threadId: REVIEWER, prompt: "hi" },
  });

const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as { type: string; text?: string }[])
    .map((item) => item.text ?? "")
    .join("");

const textAnswer = (value: string) => ({
  content: [{ type: "text", text: value }],
});

const unanswered = () =>
  ({
    _tag: "ServerRequestUnanswered",
    method: "mcpServer/tool/call",
    message: "the server closed before answering mcpServer/tool/call",
  }) as ServerRequestError;

const rejected = () =>
  ({
    _tag: "ServerRequestRejected",
    method: "mcpServer/tool/call",
    code: -32000,
    message: "tool call failed",
  }) as ServerRequestError;

const notSent = () =>
  ({
    _tag: "ServerRequestNotSent",
    method: "mcpServer/tool/call",
    message: "the connection to the server is closed",
  }) as ServerRequestError;

const waitUntil = async (condition: () => boolean) => {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() > deadline) expect.unreachable("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

type CallParams = {
  threadId: string;
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
};

type RecordedRequest = {
  method: string;
  params: CallParams;
  timeoutMs: number;
};

const CALLER = "thread-caller";
const DEFAULT_MODELS = {
  data: [
    { id: "gpt-other", model: "gpt-other", isDefault: false },
    { id: "gpt-fixture", model: "gpt-fixture", isDefault: true },
  ],
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
const UUID_CALLER = "019a0000-0000-7000-8000-0000000000aa";
const OTHER_UUID = "019a0000-0000-7000-8000-0000000000bb";
const REVIEWER = "019a0000-0000-7000-8000-000000000001";
const OTHER_WORKER = "thread-other-worker";
const OTHER_REVIEWER = "thread-other-reviewer";
