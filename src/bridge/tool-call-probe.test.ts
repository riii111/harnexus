import { describe, expect, test } from "bun:test";
import type { LogEvent } from "../shared/logger.ts";
import { createToolCallProbe, TOOL_CALL_PROBE_ENV } from "./tool-call-probe.ts";

describe("createToolCallProbe", () => {
  test("stays off unless a mode is set", () => {
    expect(createToolCallProbe({}, () => {})).toBeNull();
    expect(
      createToolCallProbe({ [TOOL_CALL_PROBE_ENV]: "write" }, () => {}),
    ).toBeNull();
  });

  test("read lists projects from the first thread once it is idle", async () => {
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

  test("send asks the second thread to reply to the first and follows both", async () => {
    const { probe, injected, events } = start("send");

    server(probe, {
      method: "thread/started",
      params: { thread: { id: THREAD_A } },
    });
    server(probe, { id: 2, result: { thread: { id: THREAD_B } } });
    await Bun.sleep(QUIET_MS * 3);
    const call = JSON.parse(injected[0] ?? "");
    probe.onOwnResponse(
      Buffer.from('{"id":"harnexus-probe-1","result":{"content":[]}}\n'),
    );
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
    expect(logged).not.toContain(SECRET);
  });

  test("reports an RPC error and a tool error apart", () => {
    const { probe, events } = start("read");

    probe.onOwnResponse(
      Buffer.from('{"id":"harnexus-probe-1","error":{"code":-1}}\n'),
    );
    probe.onOwnResponse(
      Buffer.from('{"id":"harnexus-probe-1","result":{"isError":true}}\n'),
    );

    expect(steps(events)).toEqual([
      "call_answered:A:rpc_error",
      "call_answered:A:tool_error",
    ]);
  });

  test("recognizes only its own responses", () => {
    const { probe } = start("read");

    expect(
      probe.isOwnResponse(Buffer.from('{"id":"harnexus-probe-1","result":{}}')),
    ).toBe(true);
    expect(
      probe.isOwnResponse(
        Buffer.from('{"id":"harnexus-probe-1","method":"x","params":{}}'),
      ),
    ).toBe(false);
    expect(probe.isOwnResponse(Buffer.from('{"id":1,"result":{}}'))).toBe(
      false,
    );
  });
});

const QUIET_MS = 20;
const THREAD_A = "th-caller-0001";
const THREAD_B = "th-recipient-0002";
const SECRET = "sk-probe-secret";

const start = (mode: string) => {
  const events: LogEvent[] = [];
  const injected: string[] = [];
  const created = createToolCallProbe(
    { [TOOL_CALL_PROBE_ENV]: mode },
    (entry) => events.push(entry),
    { quietMs: QUIET_MS },
  );
  expect(created).not.toBeNull();
  const probe = created as Probe;
  probe.attach((line) => injected.push(line));
  return { probe, injected, events };
};

type Probe = NonNullable<ReturnType<typeof createToolCallProbe>>;

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
