import { describe, expect, test } from "bun:test";
import { createTraceObserver } from "./trace.ts";

describe("trace", () => {
  test("keeps each message's structure and kinds without its text", () => {
    const lines = traced("server_to_app", {
      method: "item/completed",
      params: {
        threadId: "thread-parent",
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          prompt: "fix the sk-fixture-secret bug",
          receiverThreadIds: ["thread-child"],
          agentsStates: {
            "thread-child": { status: "running", message: null },
          },
        },
      },
    });

    expect(lines).toEqual([
      {
        at: 7,
        direction: "server_to_app",
        message: {
          method: "item/completed",
          params: {
            threadId: "<id 1>",
            item: {
              type: "collabAgentToolCall",
              tool: "spawnAgent",
              status: "completed",
              prompt: "<text 29>",
              receiverThreadIds: ["<id 2>"],
              agentsStates: {
                "<id 2>": { status: "running", message: null },
              },
            },
          },
        },
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain("sk-fixture-secret");
  });

  test("keeps nothing a tool or a user supplied, even under a kind's key", () => {
    const [line] = traced("server_to_app", {
      method: "item/started",
      params: {
        item: {
          type: "mcpToolCall",
          status: "my private note",
          arguments: { mode: "secret", source: "/Users/me/notes.txt" },
        },
      },
    });

    expect(line.message.params.item).toEqual({
      type: "mcpToolCall",
      status: "<text 15>",
      arguments: { mode: "<text 6>", source: "<text 19>" },
    });
  });

  test("gives the same id the same token across messages", () => {
    const written: string[] = [];
    const trace = createTraceObserver(
      (line) => written.push(line),
      () => 7,
    );

    trace.chunk("app_to_server", line({ id: 1, params: { threadId: "t-1" } }));
    trace.chunk(
      "server_to_app",
      line({ id: 1, result: { thread: { id: "t-1" } } }),
    );

    expect(written.map((text) => JSON.parse(text).message)).toEqual([
      { id: 1, params: { threadId: "<id 1>" } },
      { id: 1, result: { thread: { id: "<id 1>" } } },
    ]);
  });

  test("records a line it cannot parse without its content", () => {
    const written: string[] = [];
    const trace = createTraceObserver(
      (text) => written.push(text),
      () => 7,
    );

    trace.chunk(
      "app_to_server",
      new TextEncoder().encode("sk-fixture-secret\n"),
    );

    expect(written.map((text) => JSON.parse(text))).toEqual([
      { at: 7, direction: "app_to_server", unparsed: true },
    ]);
  });

  test("records a message split across chunks once it is whole", () => {
    const written: string[] = [];
    const trace = createTraceObserver(
      (text) => written.push(text),
      () => 7,
    );
    const bytes = line({ method: "turn/started" });

    trace.chunk("server_to_app", bytes.slice(0, 5));
    expect(written).toEqual([]);
    trace.chunk("server_to_app", bytes.slice(5));

    expect(written).toHaveLength(1);
  });
});

const traced = (
  direction: "app_to_server" | "server_to_app",
  message: object,
) => {
  const written: string[] = [];
  const trace = createTraceObserver(
    (text) => written.push(text),
    () => 7,
  );
  trace.chunk(direction, line(message));
  return written.map((text) => JSON.parse(text));
};

const line = (message: object) =>
  new TextEncoder().encode(`${JSON.stringify(message)}\n`);
