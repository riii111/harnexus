import { describe, expect, test } from "bun:test";
import { createLogger } from "../../runtime/logger.ts";
import { createObserver, serializeObservationEvent } from "./observe.ts";
import type { Direction } from "./relay.ts";

describe("createObserver", () => {
  test("names the MCP startup state and failure without the error text", () => {
    const status = (name: string, state: string, message?: string) =>
      toApp({
        method: "mcpServer/startupStatus/updated",
        params: {
          threadId: "th",
          name,
          status: state,
          error: message ?? null,
          failureReason: null,
        },
      });
    const { log, records } = observe([
      status("codex_app", "starting"),
      status("codex_app", "failed", "MCP error: Codex app tools pipe closed"),
      status(
        "codex_app",
        "failed",
        "did not provide CODEX_APP_TOOLS_PIPE_PATH",
      ),
      status("other server", "failed", "sk-secret-token at /private/path"),
    ]);

    expect(records.map((record) => record.mcpStartup)).toEqual([
      { server: "codex_app", status: "starting", failure: null },
      { server: "codex_app", status: "failed", failure: "pipe_closed" },
      { server: "codex_app", status: "failed", failure: "pipe_missing" },
      { server: "<redacted>", status: "failed", failure: "other" },
    ]);
    expect(log).not.toContain("sk-secret-token");
    expect(log).not.toContain("/private/path");
  });

  test("records direction, kind, method and id of each message and keeps params, results and errors out of the log", () => {
    const { log, records } = observe([
      toServer({
        id: 1,
        method: "thread/start",
        params: {
          cwd: "/w",
          input: [{ type: "text", text: PROMPT }],
          token: SECRET,
        },
      }),
      toApp({ method: "turn/started", params: { turnId: "t", delta: PROMPT } }),
      toApp({ id: 1, result: { thread: { id: "th" }, apiKey: SECRET } }),
      toApp({
        id: "s-1",
        method: "item/tool/call",
        params: { arguments: SECRET },
      }),
      toServer({ id: "s-1", error: { code: -1, message: SECRET } }),
      toApp({ id: 0, method: "item/tool/call", params: { arguments: SECRET } }),
      toServer({ id: 0, result: { output: SECRET } }),
      toApp({ id: 4, error: { message: SECRET } }),
    ]);

    expect(records).toEqual([
      {
        event: "rpc_message",
        direction: "app_to_server",
        kind: "request",
        method: "thread/start",
        id: 1,
        threadOpen: {
          params: ["<redacted>", "cwd"],
          ephemeral: null,
          threadSource: null,
        },
      },
      {
        event: "rpc_message",
        direction: "server_to_app",
        kind: "notification",
        method: "turn/started",
        id: null,
      },
      {
        event: "rpc_message",
        direction: "server_to_app",
        kind: "response",
        method: "thread/start",
        id: 1,
        threadOpen: { ephemeral: null, forked: false, hasParent: false },
      },
      {
        event: "rpc_message",
        direction: "server_to_app",
        kind: "request",
        method: "item/tool/call",
        id: "s-1",
      },
      {
        event: "rpc_message",
        direction: "app_to_server",
        kind: "error_response",
        method: "item/tool/call",
        id: "s-1",
      },
      {
        event: "rpc_message",
        direction: "server_to_app",
        kind: "request",
        method: "item/tool/call",
        id: 0,
      },
      {
        event: "rpc_message",
        direction: "app_to_server",
        kind: "response",
        method: "item/tool/call",
        id: 0,
      },
      {
        event: "rpc_message",
        direction: "server_to_app",
        kind: "error_response",
        method: null,
        id: 4,
      },
    ]);
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain(PROMPT);
  });

  test("does not label a response with a request from the same direction", () => {
    const { records } = observe([
      toServer({ id: 7, method: "a" }),
      toServer({ id: 7, result: {} }),
    ]);

    expect(records[1]).toMatchObject({ kind: "response", method: null });
  });

  test("records tool names and the structure of their input schemas", () => {
    const { log, records } = observe([
      toServer({
        id: 2,
        method: "thread/start",
        params: {
          dynamicTools: [
            {
              type: "function",
              name: "create_thread",
              description: PROMPT,
              inputSchema: {
                type: "object",
                title: PROMPT,
                description: PROMPT,
                properties: {
                  prompt: { type: "string", default: SECRET, pattern: SECRET },
                  mode: { enum: ["worker", SECRET] },
                  token: { const: SECRET, examples: [SECRET] },
                  kind: { $ref: "#/$defs/Kind", format: SECRET },
                },
                required: ["prompt"],
                $defs: { Kind: { type: ["string", "null"] } },
              },
            },
            {
              type: "namespace",
              name: "codex_app",
              description: PROMPT,
              tools: [{ name: "list_projects", inputSchema: true }],
            },
          ],
        },
      }),
    ]);

    expect(records[0].tools).toEqual([
      {
        name: "create_thread",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            mode: { enum: "<redacted>" },
            token: { const: "<redacted>" },
            kind: { $ref: "#/$defs/Kind" },
          },
          required: ["prompt"],
          $defs: { Kind: { type: ["string", "null"] } },
        },
      },
      { name: "codex_app.list_projects", inputSchema: true },
    ]);
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain(PROMPT);
  });

  test("stops following deeply nested namespaces without failing", () => {
    // Built as text because JSON.stringify itself overflows at this depth.
    const nest = (levels: number) =>
      `${'{"name":"n","tools":['.repeat(levels)}{"name":"t","inputSchema":true}${"]}".repeat(levels)}`;
    const line = `{"id":1,"method":"thread/start","params":{"dynamicTools":[${nest(2)},${nest(30_000)}]}}\n`;

    const { records } = observe([
      { direction: "app_to_server", line },
      toServer({ id: 2, method: "initialize" }),
    ]);

    expect(records).toHaveLength(2);
    expect(records[0].tools).toEqual([{ name: "n.n.t", inputSchema: true }]);
    expect(records[1]).toMatchObject({ method: "initialize", id: 2 });
  });

  test("records MCP tools from the server status list response", () => {
    const { records } = observe([
      toServer({ id: 9, method: "mcpServerStatus/list", params: {} }),
      toApp({
        id: 9,
        result: {
          data: [
            {
              name: "docs",
              tools: {
                search: {
                  name: "search",
                  description: PROMPT,
                  inputSchema: { type: "object" },
                },
              },
            },
          ],
        },
      }),
    ]);

    expect(records[1].tools).toEqual([
      { name: "docs.search", inputSchema: { type: "object" } },
    ]);
  });

  test("ignores tool-shaped objects outside tool definition fields", () => {
    const toolShaped = { name: SECRET, inputSchema: { const: PROMPT } };
    const { log, records } = observe([
      toServer({ id: 1, method: "turn/start", params: { input: toolShaped } }),
      toApp({
        id: "x",
        method: "item/tool/call",
        params: { arguments: { tools: [toolShaped] } },
      }),
      toServer({ id: "x", result: { contentItems: [toolShaped] } }),
      toApp({
        method: "thread/started",
        params: { dynamicTools: [toolShaped] },
      }),
    ]);

    expect(records.map((record) => record.tools)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain(PROMPT);
  });

  test("redacts wire values that do not look like identifiers", () => {
    const { log, records } = observe([
      toServer({ id: PROMPT, method: `${PROMPT} ${SECRET}` }),
      toServer({
        id: 5,
        method: "thread/start",
        params: { dynamicTools: [{ name: PROMPT, inputSchema: {} }] },
      }),
    ]);

    expect(records[0]).toMatchObject({
      method: "<redacted>",
      id: "<redacted>",
    });
    expect(records[1].tools).toEqual([{ name: "<redacted>", inputSchema: {} }]);
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain(PROMPT);
  });

  test.each([
    {
      name: "invalid JSON",
      direction: "app_to_server",
      line: `{"id":1,"method":"${SECRET}\n`,
      expected: "invalid_json",
    },
    {
      name: "a JSON value that is not an object",
      direction: "app_to_server",
      line: `["${SECRET}"]\n`,
      expected: "not_object",
    },
    {
      name: "an object of unknown shape",
      direction: "app_to_server",
      line: `{"secret":"${SECRET}"}\n`,
      expected: "unknown_shape",
    },
    {
      name: "a line over the size limit",
      direction: "server_to_app",
      line: `{"id":1,"result":"${SECRET}${SECRET}"}\n`,
      expected: "too_large",
    },
  ])("counts $name as unobserved without logging its content", ({
    direction,
    line,
    expected,
  }) => {
    const { log, records } = observe([{ direction, line }], {
      maxLineBytes: 48,
    });

    expect(records).toEqual([
      { event: "rpc_unobserved", direction, reason: expected },
    ]);
    expect(log).not.toContain(SECRET);
  });

  test("records the protocol fields a thread fork names and what the server opened, without ids or text", () => {
    const { log, records } = observe([
      toServer({
        id: 2,
        method: "thread/fork",
        params: {
          threadId: SECRET,
          ephemeral: true,
          threadSource: "user",
          developerInstructions: PROMPT,
          [SECRET]: 1,
          "/private/path": 2,
        },
      }),
      toApp({
        id: 2,
        result: {
          thread: {
            id: SECRET,
            ephemeral: true,
            forkedFromId: SECRET,
            parentThreadId: null,
          },
        },
      }),
    ]);

    expect(records.map((record) => record.threadOpen)).toEqual([
      {
        params: [
          "<redacted>",
          "developerInstructions",
          "ephemeral",
          "threadId",
          "threadSource",
        ],
        ephemeral: true,
        threadSource: "user",
      },
      { ephemeral: true, forked: true, hasParent: false },
    ]);
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain(PROMPT);
    expect(log).not.toContain("/private/path");
  });

  test.each([
    {
      name: "missing params",
      message: { id: 3, method: "thread/fork" },
      expected: { params: [], ephemeral: null, threadSource: null },
    },
    {
      name: "params that are not an object",
      message: { id: 4, method: "thread/fork", params: [SECRET] },
      expected: { params: [], ephemeral: null, threadSource: null },
    },
    {
      name: "mistyped values",
      message: {
        id: 5,
        method: "thread/start",
        params: { ephemeral: "yes", threadSource: PROMPT },
      },
      expected: {
        params: ["ephemeral", "threadSource"],
        ephemeral: null,
        threadSource: "<redacted>",
      },
    },
  ])("reads a thread open with $name as naming nothing", ({
    message,
    expected,
  }) => {
    const { log, records } = observe([toServer(message)]);

    expect(records[0].threadOpen).toEqual(expected);
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain(PROMPT);
  });

  test.each([
    { source: "user", expected: "user" },
    { source: "guardian_review", expected: "guardian_review" },
    { source: "side_chat", expected: "side_chat" },
    { source: "sk-ant-api03-Key0", expected: "<redacted>" },
    { source: "/private/path", expected: "<redacted>" },
    { source: "Feature", expected: "<redacted>" },
  ])("records the thread source $source as $expected", ({
    source,
    expected,
  }) => {
    const { records } = observe([
      toServer({
        id: 1,
        method: "thread/fork",
        params: { threadSource: source },
      }),
    ]);

    expect(records[0].threadOpen.threadSource).toBe(expected);
  });

  test("does not read a thread open sent the other way", () => {
    const { records } = observe([
      toApp({ id: 6, method: "thread/start", params: { cwd: "/w" } }),
      toServer({ id: 6, result: { thread: { ephemeral: true } } }),
    ]);

    expect(records.map((record) => record.threadOpen)).toEqual([
      undefined,
      undefined,
    ]);
  });

  test("records nothing for an empty line", () => {
    const { records } = observe([{ direction: "server_to_app", line: "\n" }]);

    expect(records).toEqual([]);
  });
});

const SECRET = "sk-secret-token-0123";
const PROMPT = "private conversation text";

const encode = (text: string) => new TextEncoder().encode(text);

const observe = (
  messages: { direction: Direction; line: string }[],
  options: { maxLineBytes?: number } = {},
) => {
  const lines: string[] = [];
  const logger = createLogger(
    (line) => lines.push(line),
    serializeObservationEvent,
  );
  const observer = createObserver(logger.log, options);
  for (const { direction, line } of messages) {
    observer.chunk(direction, encode(line));
  }
  observer.end("app_to_server");
  observer.end("server_to_app");
  const log = lines.join("");
  const records = lines.map((line) => {
    const { time: _time, ...rest } = JSON.parse(line);
    return rest;
  });
  return { log, records };
};

const toServer = (message: unknown) => ({
  direction: "app_to_server" as const,
  line: `${JSON.stringify(message)}\n`,
});
const toApp = (message: unknown) => ({
  direction: "server_to_app" as const,
  line: `${JSON.stringify(message)}\n`,
});
