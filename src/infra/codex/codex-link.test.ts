import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type InferErr, Result } from "better-result";
import { createCodexLink } from "./codex-link.ts";
import { createDelegationWatch } from "./delegations.ts";
import type { ServerRequest } from "./server-requests.ts";

describe("createCodexLink tools", () => {
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

  test("names the created thread so a later message can reach it", async () => {
    const { client, requests } = await connect({
      answer: (params) =>
        Result.ok(
          params.tool === "create_thread"
            ? textAnswer(JSON.stringify({ threadId: REVIEWER }))
            : textAnswer("sent"),
        ),
    });

    const created = await client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: TARGET },
    });
    const sent = await client.callTool({
      name: "send_message_to_thread",
      arguments: { threadId: REVIEWER, prompt: "again" },
    });

    expect(created.structuredContent).toEqual({ threadId: REVIEWER });
    expect(sent.isError).toBeFalsy();
    expect(requests.map((request) => request.params.arguments)).toEqual([
      { prompt: "review", target: TARGET, model: "gpt-fixture" },
      { threadId: REVIEWER, prompt: "again" },
    ]);
  });

  test("learns the created thread from the app's first turn on it when the answer has only a provisional id", async () => {
    const delegations = createDelegationWatch();
    const { client } = await connect({
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

    expect(created.structuredContent).toEqual({ threadId: REVIEWER });
    expect(text(created)).toContain(REVIEWER);
  });

  test("never takes the late first turn of a thread an earlier answer already named", async () => {
    const delegations = createDelegationWatch();
    let creates = 0;
    const { client, link } = await connect({
      delegations,
      answer: (params) => {
        if (params.tool !== "create_thread") return Result.ok(textAnswer("ok"));
        creates += 1;
        if (creates === 1) {
          return Result.ok(textAnswer(JSON.stringify({ threadId: REVIEWER })));
        }
        delegations.observe(CALLER, REVIEWER);
        return Result.ok(textAnswer(JSON.stringify(PROVISIONAL)));
      },
    });

    const first = await client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: TARGET },
    });
    const second = await client.callTool({
      name: "create_thread",
      arguments: { prompt: "review again", target: TARGET },
    });

    expect(first.structuredContent).toEqual({ threadId: REVIEWER });
    expect(second.isError).toBe(true);
    expect(second.structuredContent).toBeUndefined();
    expect(link.hasUnsettledWrite()).toBe(true);
  });

  test("creates a worker on the requested Claude model", async () => {
    const { client, requests, modelLists } = await connect({
      answer: () =>
        Result.ok(textAnswer(JSON.stringify({ threadId: REVIEWER }))),
    });

    const created = await client.callTool({
      name: "create_thread",
      arguments: { prompt: "work", target: TARGET, model: "claude-sonnet-5" },
    });

    expect(created.structuredContent).toEqual({ threadId: REVIEWER });
    expect(requests[0]?.params.arguments.model).toBe("claude-sonnet-5");
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

  test("accepts no hostId and never forwards it, even nested in wait targets", async () => {
    const { client, requests } = await connect({
      answer: () => Result.ok(textAnswer("ok")),
    });

    const { tools } = await client.listTools();
    await client.callTool({
      name: "wait_threads",
      arguments: { targets: [{ threadId: CALLER, hostId: "remote" }] },
    });

    expect(tools.map((tool) => tool.name)).toContain("wait_threads");
    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain(
        "hostId",
      );
    }
    expect(requests[0]?.params.arguments).toEqual({
      targets: [{ threadId: CALLER }],
    });
  });

  test("prefers a thread id in the structured answer over one in the text", async () => {
    const { client } = await connect({
      answer: () =>
        Result.ok({
          ...textAnswer(JSON.stringify({ threadId: OTHER_REVIEWER })),
          structuredContent: { threadId: REVIEWER },
        }),
    });

    const created = await client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: TARGET },
    });

    expect(created.structuredContent).toEqual({ threadId: REVIEWER });
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
  test("messages, reads and waits on a thread it neither created nor got work from", async () => {
    const { client, requests } = await connect({
      answer: () => Result.ok(textAnswer("ok")),
    });

    const results = [
      await client.callTool({
        name: "send_message_to_thread",
        arguments: { threadId: OTHER_REVIEWER, prompt: "a shared finding" },
      }),
      await client.callTool({
        name: "read_thread",
        arguments: { threadId: OTHER_WORKER },
      }),
      await client.callTool({
        name: "wait_threads",
        arguments: {
          targets: [{ threadId: CALLER }, { threadId: OTHER_REVIEWER }],
          timeoutMs: 1_000,
        },
      }),
    ];

    expect(results.map((result) => result.isError ?? false)).toEqual([
      false,
      false,
      false,
    ]);
    expect(requests.map((request) => request.params.tool)).toEqual([
      "send_message_to_thread",
      "read_thread",
      "wait_threads",
    ]);
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

  test.each([
    {
      name: "an item missing its text",
      answer: { content: [{ type: "text" }] },
    },
    { name: "no content", answer: { unexpected: true } },
  ])("treats an answer to a write with $name as an unknown outcome", async ({
    answer,
  }) => {
    const { client, link } = await connect({
      answer: () => Result.ok(answer),
    });

    const sent = await send(client);

    expect(sent.isError).toBe(true);
    expect(link.hasUnsettledWrite()).toBe(true);
  });

  test("lets a write that was never sent, or that the app refused, be tried again", async () => {
    let calls = 0;
    const { client, link, requests } = await connect({
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

  test.each([
    {
      name: "only a provisional id",
      body: JSON.stringify({ clientThreadId: REVIEWER, status: "queued" }),
    },
    { name: "no single thread id", body: "Created two: a and b" },
  ])("stops writing when a created thread's answer has $name", async ({
    body,
  }) => {
    const { client, link } = await connect({
      answer: () => Result.ok(textAnswer(body)),
    });

    const created = await client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: TARGET },
    });

    expect(created.isError).toBe(true);
    expect(created.structuredContent).toBeUndefined();
    expect(link.hasUnsettledWrite()).toBe(true);
  });

  test("holds a second write until the first is decided and drops it when that was lost", async () => {
    let release: (value: Result<unknown, ServerRequestError>) => void =
      () => {};
    const { client, requests } = await connect({
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
      answer: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const first = send(client);
    await waitUntil(() => requests.length === 1);
    const second = send(client);
    await new Promise((resolve) => setTimeout(resolve, 20));

    link.stopWrites();
    release(Result.ok(textAnswer("sent")));
    await first;

    expect(text(await second)).toContain("stopped");
    expect(requests).toHaveLength(1);
    expect(link.hasUnsettledWrite()).toBe(false);
  });

  test("refuses a write that arrives after the stop until writes are accepted again", async () => {
    const { client, link, requests } = await connect({});

    link.stopWrites();
    const late = await send(client);
    expect(text(late)).toContain("stopped");
    expect(requests).toHaveLength(0);
    link.acceptWrites();
    const next = await send(client);

    expect(next.isError).toBeFalsy();
    expect(requests).toHaveLength(1);
  });

  test("reports a write still waiting for its answer as unsettled, as when a turn is stopped mid-call", async () => {
    let release: (value: Result<unknown, ServerRequestError>) => void =
      () => {};
    const { client, link, requests } = await connect({
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

describe("createCodexLink automation_update", () => {
  let codexHome = "";

  beforeAll(async () => {
    codexHome = await mkdtemp(join(tmpdir(), "harnexus-automations-"));
    for (const [id, toml] of Object.entries(AUTOMATIONS)) {
      await mkdir(join(codexHome, "automations", id), { recursive: true });
      await writeFile(
        join(codexHome, "automations", id, "automation.toml"),
        toml,
      );
    }
  });

  afterAll(async () => {
    await rm(codexHome, { recursive: true, force: true });
  });

  test("creates a heartbeat that wakes the calling thread even when asked for another thread or a cron", async () => {
    const { client, requests } = await connect({ codexHome });

    const created = await client.callTool({
      name: "automation_update",
      arguments: {
        mode: "create",
        ...HEARTBEAT,
        kind: "cron",
        targetThreadId: OTHER_WORKER,
      },
    });

    expect(created.isError).toBeFalsy();
    expect(requests).toEqual([
      {
        method: "mcpServer/tool/call",
        params: {
          threadId: CALLER,
          server: "codex_app",
          tool: "automation_update",
          arguments: {
            mode: "create",
            ...HEARTBEAT,
            kind: "heartbeat",
            targetThreadId: CALLER,
          },
        },
        timeoutMs: 120_000,
      },
    ]);
  });

  test.each([
    {
      name: "view",
      args: { mode: "view", id: "mine" },
      expected: { mode: "view", id: "mine" },
    },
    {
      name: "update",
      args: { mode: "update", id: "mine", ...HEARTBEAT, status: "PAUSED" },
      expected: {
        mode: "update",
        id: "mine",
        ...HEARTBEAT,
        status: "PAUSED",
        kind: "heartbeat",
        targetThreadId: CALLER,
      },
    },
    {
      name: "delete",
      args: { mode: "delete", id: "mine" },
      expected: { mode: "delete", id: "mine" },
    },
  ])("sends a $name of a heartbeat that wakes the calling thread", async ({
    args,
    expected,
  }) => {
    const { client, requests } = await connect({ codexHome });

    const result = await client.callTool({
      name: "automation_update",
      arguments: args,
    });

    expect(result.isError).toBeFalsy();
    expect(requests.map((request) => request.params.arguments)).toEqual([
      expected,
    ]);
  });

  test.each([
    { name: "a heartbeat of another thread", id: "theirs" },
    { name: "a cron automation", id: "nightly" },
    {
      name: "another thread's heartbeat whose prompt names the caller",
      id: "disguised",
    },
    { name: "an automation the app has no file for", id: "missing" },
  ])("refuses to change $name without calling the app", async ({ id }) => {
    const { client, requests } = await connect({ codexHome });

    const deleted = await client.callTool({
      name: "automation_update",
      arguments: { mode: "delete", id },
    });

    expect(deleted.isError).toBe(true);
    expect(text(deleted)).toContain("not a heartbeat of this thread");
    expect(requests).toEqual([]);
  });

  test.each([
    { name: "an update without an id", args: { mode: "update", ...HEARTBEAT } },
    { name: "a create with an id", args: { mode: "create", id: "mine" } },
    {
      name: "an id that leaves the automations directory",
      args: { mode: "view", id: ".." },
    },
  ])("refuses $name without calling the app", async ({ args }) => {
    const { client, requests } = await connect({ codexHome });

    const result = await client.callTool({
      name: "automation_update",
      arguments: args,
    });

    expect(result.isError).toBe(true);
    expect(requests).toEqual([]);
  });

  test("never creates another heartbeat after a create whose answer was lost", async () => {
    const { client, link, requests } = await connect({
      codexHome,
      answer: () => Result.err(unanswered()),
    });
    const create = () =>
      client.callTool({
        name: "automation_update",
        arguments: { mode: "create", ...HEARTBEAT },
      });

    const first = await create();
    const second = await create();

    expect(text(first)).toContain("may or may not have taken effect");
    expect(text(second)).toContain("unknown outcome");
    expect(requests).toHaveLength(1);
    expect(link.hasUnsettledWrite()).toBe(true);
  });
});

describe("createCodexLink call", () => {
  test("runs a tool by name the same way as the tool itself", async () => {
    const { link, requests } = await connect({
      answer: () =>
        Result.ok(textAnswer(JSON.stringify({ threadId: REVIEWER }))),
    });

    const result = await link.call("create_thread", {
      prompt: "review",
      target: TARGET,
    });

    expect(result.structuredContent).toEqual({ threadId: REVIEWER });
    expect(requests.map((request) => request.params.arguments)).toEqual([
      { prompt: "review", target: TARGET, model: "gpt-fixture" },
    ]);
  });

  test.each([
    { name: "an unknown tool", tool: "delete_thread", args: {} },
    {
      name: "arguments the tool does not accept",
      tool: "create_thread",
      args: { prompt: "" },
    },
  ])("refuses $name without calling the app", async ({ tool, args }) => {
    const { link, requests } = await connect();

    const result = await link.call(tool, args);

    expect(result.isError).toBe(true);
    expect(requests).toEqual([]);
  });
});

describe("createCodexLink createChecked", () => {
  test.each([
    {
      name: "a first turn on the sent model and effort",
      actual: { model: "gpt-fixture", effort: "low" },
      refused: false,
    },
    {
      name: "a first turn on another model",
      actual: { model: "gpt-other", effort: "low" },
      refused: true,
    },
  ])("names the created thread and reports $name", async ({
    actual,
    refused,
  }) => {
    const delegations = createDelegationWatch();
    const runs: boolean[] = [];
    const { link } = await connect({
      delegations,
      answer: () => {
        runs.push(delegations.observe(CALLER, REVIEWER, actual));
        return Result.ok(textAnswer(JSON.stringify(PROVISIONAL)));
      },
    });

    const created = await link.createChecked({
      prompt: "review",
      target: TARGET,
      thinking: "low",
    });

    expect(runs).toEqual([!refused]);
    expect(created.firstTurn).toEqual({
      threadId: REVIEWER,
      expected: { model: "gpt-fixture", effort: "low" },
      actual,
      refused,
      refusal: null,
    });
    expect(created.result.isError === true).toBe(refused);
    expect(created.unknown).toBe(false);
    expect(created.threadId).toBe(REVIEWER);
  });

  test("reports the real id the app named as unknown while its first turn is unseen", async () => {
    const delegations = createDelegationWatch();
    const { link } = await connect({
      delegations,
      answer: () =>
        Result.ok(textAnswer(JSON.stringify({ threadId: REVIEWER }))),
    });

    const created = await link.createChecked({
      prompt: "review",
      target: TARGET,
    });

    expect(created.unknown).toBe(true);
    expect(created.threadId).toBe(REVIEWER);
  });

  test("keeps the check armed when the first turn is not seen in time", async () => {
    const delegations = createDelegationWatch();
    const { link } = await connect({
      delegations,
      answer: () => Result.ok(textAnswer(JSON.stringify(PROVISIONAL))),
    });

    const created = await link.createChecked({
      prompt: "review",
      target: TARGET,
      model: "gpt-worker",
    });

    expect(created.unknown).toBe(true);
    expect(
      delegations.observe(CALLER, REVIEWER, {
        model: "gpt-other",
        effort: null,
      }),
    ).toBe(false);
  });

  test("reports a refused first turn even when the app then answers with an error", async () => {
    const delegations = createDelegationWatch();
    const { link } = await connect({
      delegations,
      answer: () => {
        delegations.observe(CALLER, REVIEWER, {
          model: "gpt-other",
          effort: null,
        });
        return Result.ok({ ...textAnswer("first turn failed"), isError: true });
      },
    });

    const created = await link.createChecked({
      prompt: "review",
      target: TARGET,
    });

    expect(created.firstTurn?.refused).toBe(true);
    expect(created.unknown).toBe(false);
  });

  test("checks the first turn of a thread the app's answer named", async () => {
    const delegations = createDelegationWatch();
    const { link } = await connect({
      delegations,
      answer: () => {
        setTimeout(
          () =>
            delegations.observe(CALLER, REVIEWER, {
              model: "gpt-other",
              effort: null,
            }),
          5,
        );
        return Result.ok(textAnswer(JSON.stringify({ threadId: REVIEWER })));
      },
    });

    const created = await link.createChecked({
      prompt: "review",
      target: TARGET,
    });

    expect(created.firstTurn?.refused).toBe(true);
  });
});

describe("createCodexLink creates of one caller from two links", () => {
  test("refuses an in-chat create while a socket create of the same thread is unconfirmed", async () => {
    const delegations = createDelegationWatch();
    const answered = deferred();
    const socket = await connect({
      delegations,
      answer: async () => {
        await answered.promise;
        return Result.ok(textAnswer(JSON.stringify(PROVISIONAL)));
      },
    });
    const chat = await connect({ delegations });

    const socketCreate = socket.link.createChecked({
      prompt: "work",
      target: TARGET,
      model: "gpt-worker",
    });
    await waitUntil(() => socket.requests.length === 1);
    const inChat = await chat.client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: TARGET },
    });
    const runs = delegations.observe(CALLER, REVIEWER, {
      model: "gpt-other",
      effort: null,
    });
    answered.resolve();

    expect(inChat.isError).toBe(true);
    expect(chat.requests).toEqual([]);
    expect(runs).toBe(false);
    expect((await socketCreate).firstTurn?.refused).toBe(true);
  });

  test("sends no socket create while an in-chat create of the same thread is unconfirmed", async () => {
    const delegations = createDelegationWatch();
    const answered = deferred();
    const chat = await connect({
      delegations,
      answer: async () => {
        await answered.promise;
        return Result.ok(textAnswer(JSON.stringify(PROVISIONAL)));
      },
    });
    const socket = await connect({ delegations });

    const inChat = chat.client.callTool({
      name: "create_thread",
      arguments: { prompt: "review", target: TARGET },
    });
    await waitUntil(() => chat.requests.length === 1);
    const socketCreate = await socket.link.createChecked({
      prompt: "work",
      target: TARGET,
      model: "gpt-worker",
    });
    const runs = delegations.observe(CALLER, REVIEWER, {
      model: "gpt-other",
      effort: null,
    });
    answered.resolve();

    expect(socketCreate.busy).toBe(true);
    expect(socket.requests).toEqual([]);
    expect(runs).toBe(true);
    expect((await inChat).structuredContent).toEqual({ threadId: REVIEWER });
  });

  test("keeps the check of a thread named by an error answer", async () => {
    const delegations = createDelegationWatch();
    const { link } = await connect({
      delegations,
      answer: () =>
        Result.ok({
          ...textAnswer(JSON.stringify({ threadId: REVIEWER })),
          isError: true,
        }),
    });

    const created = await link.createChecked({
      prompt: "work",
      target: TARGET,
      model: "gpt-worker",
    });

    expect(created).toMatchObject({ threadId: REVIEWER, unknown: true });
    expect(
      delegations.observe(CALLER, REVIEWER, {
        model: "gpt-other",
        effort: null,
      }),
    ).toBe(false);
  });
});

const deferred = () => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const connect = async ({
  callerRegistered = true,
  codexHome = "/fixture/.codex",
  delegations = createDelegationWatch(),
  models = () => Result.ok(DEFAULT_MODELS),
  answer = () => Result.ok(textAnswer("ok")),
}: {
  delegations?: ReturnType<typeof createDelegationWatch>;
  models?: (
    params: Record<string, unknown>,
  ) => Result<unknown, ServerRequestError>;
  callerRegistered?: boolean;
  codexHome?: string;
  answer?: (
    params: CallParams,
  ) =>
    | Result<unknown, ServerRequestError>
    | Promise<Result<unknown, ServerRequestError>>;
} = {}) => {
  const store = {
    get: (threadId: string) =>
      callerRegistered && threadId === CALLER ? {} : undefined,
  };
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
    callerThreadId: CALLER,
    store,
    request,
    delegations,
    codexHome,
    createdThreadWaitMs: 20,
    firstTurnWaitMs: 20,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await link.server.instance.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return { client, link, requests, modelLists };
};

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

type ServerRequestError = InferErr<Awaited<ReturnType<ServerRequest>>>;

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
const REVIEWER = "019a0000-0000-7000-8000-000000000001";
const OTHER_WORKER = "thread-other-worker";
const OTHER_REVIEWER = "thread-other-reviewer";
const HEARTBEAT = {
  name: "CI watch",
  prompt: "Check the CI run and report only when it finishes or fails.",
  rrule: "FREQ=MINUTELY;INTERVAL=30",
  status: "ACTIVE",
};
const AUTOMATIONS = {
  mine: `version = 1\nid = "mine"\nkind = "heartbeat"\ntarget_thread_id = "${CALLER}"\n`,
  theirs: `version = 1\nid = "theirs"\nkind = "heartbeat"\ntarget_thread_id = "${OTHER_WORKER}"\n`,
  nightly: `version = 1\nid = "nightly"\nkind = "cron"\nmodel = "gpt-fixture"\n`,
  disguised: `version = 1\nid = "disguised"\nkind = "heartbeat"\nprompt = """\ntarget_thread_id = "${CALLER}"\n"""\ntarget_thread_id = "${OTHER_WORKER}"\n`,
};
