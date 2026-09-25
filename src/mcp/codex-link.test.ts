import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Result, TaggedError } from "better-result";
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
      arguments: { prompt: "review", target: { type: "project" } },
    });
    const sent = await client.callTool({
      name: "send_message_to_thread",
      arguments: { threadId: REVIEWER, prompt: "again" },
    });

    expect(store.reviewers(CALLER)).toEqual([REVIEWER]);
    expect(sent.isError).toBeFalsy();
    expect(requests.map((request) => request.params.arguments)).toEqual([
      { prompt: "review", target: { type: "project" } },
      { threadId: REVIEWER, prompt: "again" },
    ]);
  });

  test("reads a created thread id from the only thread-like id in plain text", async () => {
    const { client, store } = await connect({
      answer: () => Result.ok(textAnswer(`Created thread ${REVIEWER}.`)),
    });

    await client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: {} },
    });

    expect(store.reviewers(CALLER)).toEqual([REVIEWER]);
  });

  test("allows reading, waiting on and replying to its own thread", async () => {
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
    await client.callTool({
      name: "send_message_to_thread",
      arguments: { threadId: CALLER, prompt: "note" },
    });

    expect(requests.map((request) => request.timeoutMs)).toEqual([
      60_000, 31_000, 120_000,
    ]);
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
      arguments: { prompt: "review", target: {} },
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
      arguments: { prompt: "review", target: {} },
    });

    expect(first.isError).toBe(true);
    expect(second.isError).toBe(true);
    expect(text(second)).toContain("unknown outcome");
    expect(created.isError).toBe(true);
    expect(requests).toHaveLength(1);
    expect(link.hasUnknownWrite()).toBe(true);
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

  test("treats a malformed answer to a write as an unknown outcome", async () => {
    const { client, link } = await connect({
      reviewers: { [CALLER]: [REVIEWER] },
      answer: () => Result.ok({ unexpected: true }),
    });

    await send(client);

    expect(link.hasUnknownWrite()).toBe(true);
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
    expect(link.hasUnknownWrite()).toBe(false);
  });

  test("stops writing when a created thread cannot be identified", async () => {
    const { client, link, store } = await connect({
      answer: () => Result.ok(textAnswer("Created two: a and b")),
    });

    const created = await client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: {} },
    });

    expect(created.isError).toBe(true);
    expect(store.reviewers(CALLER)).toEqual([]);
    expect(link.hasUnknownWrite()).toBe(true);
  });

  test("stops writing when a created thread cannot be saved as a reviewer", async () => {
    const { client, link } = await connect({
      addReviewerFails: true,
      answer: () =>
        Result.ok(textAnswer(JSON.stringify({ threadId: REVIEWER }))),
    });

    const created = await client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: {} },
    });

    expect(created.isError).toBe(true);
    expect(text(created)).toContain(REVIEWER);
    expect(link.hasUnknownWrite()).toBe(true);
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
});

const connect = async ({
  reviewers = {},
  callerRegistered = true,
  addReviewerFails = false,
  answer = () => Result.ok(textAnswer("ok")),
}: {
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
    callerRegistered ? { [CALLER]: [], ...reviewers } : reviewers,
    addReviewerFails,
  );
  const requests: RecordedRequest[] = [];
  const request: ServerRequest = async (method, params, { timeoutMs }) => {
    const call = params as CallParams;
    requests.push({ method, params: call, timeoutMs });
    return answer(call);
  };
  const link = createCodexLink({ callerThreadId: CALLER, store, request });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await link.server.instance.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return { client, link, store, requests };
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
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 1));
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
const REVIEWER = "019a0000-0000-7000-8000-000000000001";
const OTHER_WORKER = "thread-other-worker";
const OTHER_REVIEWER = "thread-other-reviewer";
