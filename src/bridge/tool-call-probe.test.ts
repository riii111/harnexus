import { describe, expect, test } from "bun:test";
import type { LogEvent } from "../shared/logger.ts";
import {
  CALLER_THREAD_ENV,
  createToolCallProbe,
  TARGET_THREAD_ENV,
  TOOL_CALL_PROBE_ENV,
} from "./tool-call-probe.ts";

describe("createToolCallProbe", () => {
  test.each([
    { name: "no mode is set", env: {} },
    { name: "the mode is unknown", env: { [TOOL_CALL_PROBE_ENV]: "write" } },
  ])("stays off when $name", ({ env }) => {
    expect(createToolCallProbe(env, () => {})).toBeNull();
  });

  test.each([
    {
      name: "no caller thread",
      env: { [TOOL_CALL_PROBE_ENV]: "read" },
      expected: "refused:caller_missing",
    },
    {
      name: "no target thread",
      env: { [TOOL_CALL_PROBE_ENV]: "send", [CALLER_THREAD_ENV]: THREAD_A },
      expected: "refused:target_missing",
    },
    {
      name: "the same caller and target thread",
      env: {
        [TOOL_CALL_PROBE_ENV]: "send",
        [CALLER_THREAD_ENV]: THREAD_A,
        [TARGET_THREAD_ENV]: THREAD_A,
      },
      expected: "refused:same_thread",
    },
  ])("refuses to run with $name", ({ env, expected }) => {
    const events: LogEvent[] = [];

    const probe = createToolCallProbe(env, (entry) => events.push(entry));

    expect(probe).toBeNull();
    expect(steps(events)).toEqual([expected]);
  });

  test("read lists projects from the named thread once it is idle", async () => {
    const { probe, injected, events } = start("read");

    server(probe, { id: 1, result: { thread: { id: THREAD_A } } });
    server(probe, turnStarted(THREAD_A));
    await Bun.sleep(QUIET_MS * 3);
    expect(injected).toEqual([]);

    server(probe, turnCompleted(THREAD_A));
    await Bun.sleep(QUIET_MS * 3);

    expect(injected).toHaveLength(1);
    expect(JSON.parse(injected[0] ?? "")).toEqual({
      id: "harnexus-probe-1",
      method: "mcpServer/tool/call",
      params: {
        threadId: THREAD_A,
        server: "codex_app",
        tool: "list_projects",
        arguments: {},
      },
    });
    expect(steps(events)).toEqual([
      "thread_seen:A",
      "turn_started:A",
      "turn_completed:A",
      "call_sent:A:list_projects",
    ]);
  });

  test("never sends to threads it was not given, and waits until both are loaded", async () => {
    const { probe, injected, events } = start("send");

    server(probe, { id: 1, result: { thread: { id: UNRELATED_1 } } });
    server(probe, { id: 2, result: { thread: { id: UNRELATED_2 } } });
    server(probe, { id: 3, result: { thread: { id: THREAD_A } } });
    await Bun.sleep(QUIET_MS * 3);

    expect(injected).toEqual([]);
    expect(steps(events)).toEqual(["thread_seen:A"]);
  });

  test("send asks the target to reply to the caller and follows both", async () => {
    const { probe, injected, events } = start("send");

    server(probe, {
      method: "thread/started",
      params: { thread: { id: UNRELATED_1 } },
    });
    server(probe, {
      method: "thread/started",
      params: { thread: { id: THREAD_A } },
    });
    server(probe, { id: 2, result: { thread: { id: THREAD_B } } });
    await Bun.sleep(QUIET_MS * 3);
    const call = JSON.parse(injected[0] ?? "");
    answerWith(probe, '{"id":"harnexus-probe-1","result":{"content":[]}}');
    server(probe, {
      id: 7,
      method: "mcpServer/elicitation/request",
      params: { threadId: THREAD_A },
    });
    app(probe, { id: 7, result: { action: "accept", content: { x: SECRET } } });
    app(probe, { id: 3, method: "turn/start", params: { threadId: THREAD_B } });
    app(probe, { id: 4, method: "turn/start", params: { threadId: THREAD_A } });

    expect(call.params).toMatchObject({
      threadId: THREAD_A,
      tool: "send_message_to_thread",
      arguments: { threadId: THREAD_B },
    });
    expect(call.params.arguments.prompt).toContain(THREAD_A);
    expect(steps(events)).toEqual([
      "thread_seen:A",
      "thread_seen:B",
      "call_sent:A:send_message_to_thread",
      "call_answered:A:ok",
      "approval_requested:A:mcpServer/elicitation/request",
      "approval_answered:A:accept",
      "turn_start_requested:B",
      "turn_start_requested:A",
    ]);
    const logged = JSON.stringify(events);
    expect(logged).not.toContain(THREAD_A);
    expect(logged).not.toContain(THREAD_B);
    expect(logged).not.toContain(SECRET);
  });

  test("matches no response before it sends a request", () => {
    const { probe } = start("read");

    expect(own(probe, '{"id":"harnexus-probe-1","result":{}}')).toBe(false);
  });

  test.each([
    {
      name: "a response that nests the request id",
      line: '{"id":12,"result":{"nested":{"id":"harnexus-probe-1"}}}',
    },
    {
      name: "a request that reuses the request id",
      line: '{"id":"harnexus-probe-1","method":"x","params":{}}',
    },
  ])("does not match $name", async ({ line }) => {
    const probe = await sentRead();

    expect(own(probe, line)).toBe(false);
  });

  test("matches the top-level response regardless of spacing or nested fields", async () => {
    const probe = await sentRead();

    expect(
      own(
        probe,
        '{ "id" : "harnexus-probe-1", "result": {"method": "inside"} }',
      ),
    ).toBe(true);
  });

  test("stops matching once the response is handled", async () => {
    const probe = await sentRead();

    probe.onOwnResponse(Buffer.alloc(0));

    expect(own(probe, '{"id":"harnexus-probe-1","result":{}}')).toBe(false);
  });

  test.each([
    {
      name: "an RPC error",
      response: '{"id":"harnexus-probe-1","error":{"code":-1}}',
      expected: "call_answered:A:rpc_error",
    },
    {
      name: "a tool error",
      response: '{"id":"harnexus-probe-1","result":{"isError":true}}',
      expected: "call_answered:A:tool_error",
    },
  ])("reports $name", async ({ response, expected }) => {
    const { probe, events } = start("read");
    server(probe, { id: 1, result: { thread: { id: THREAD_A } } });
    await Bun.sleep(QUIET_MS * 3);

    answerWith(probe, response);

    expect(steps(events).at(-1)).toBe(expected);
  });
});

const QUIET_MS = 20;
const THREAD_A = "th-caller-0001";
const THREAD_B = "th-recipient-0002";
const UNRELATED_1 = "th-unrelated-0003";
const UNRELATED_2 = "th-unrelated-0004";
const SECRET = "sk-probe-secret";

type Probe = NonNullable<ReturnType<typeof createToolCallProbe>>;

const start = (mode: "read" | "send") => {
  const events: LogEvent[] = [];
  const injected: string[] = [];
  const created = createToolCallProbe(
    {
      [TOOL_CALL_PROBE_ENV]: mode,
      [CALLER_THREAD_ENV]: THREAD_A,
      [TARGET_THREAD_ENV]: THREAD_B,
    },
    (entry) => events.push(entry),
    { quietMs: QUIET_MS },
  );
  expect(created).not.toBeNull();
  const probe = created as Probe;
  probe.attach((line) => injected.push(line));
  return { probe, injected, events };
};

const sentRead = async () => {
  const { probe } = start("read");
  server(probe, { id: 1, result: { thread: { id: THREAD_A } } });
  await Bun.sleep(QUIET_MS * 3);
  return probe;
};

const own = (probe: Probe, text: string) =>
  probe.isOwnResponse(Buffer.from(text));

const answerWith = (probe: Probe, text: string) => {
  const line = Buffer.from(text);
  expect(probe.isOwnResponse(line)).toBe(true);
  probe.onOwnResponse(line);
};

const server = (probe: Probe, message: object) =>
  probe.observer.chunk(
    "server_to_app",
    Buffer.from(`${JSON.stringify(message)}\n`),
  );

const app = (probe: Probe, message: object) =>
  probe.observer.chunk(
    "app_to_server",
    Buffer.from(`${JSON.stringify(message)}\n`),
  );

const turnStarted = (threadId: string) => ({
  method: "turn/started",
  params: { threadId },
});

const turnCompleted = (threadId: string) => ({
  method: "turn/completed",
  params: { threadId },
});

const steps = (events: LogEvent[]) =>
  events.flatMap((entry) =>
    entry.event === "tool_call_probe"
      ? [
          [entry.step, entry.role, entry.detail]
            .filter((part) => part !== null)
            .join(":"),
        ]
      : [],
  );
