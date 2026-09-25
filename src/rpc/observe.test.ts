import { describe, expect, test } from "bun:test";
import { createLogger } from "../shared/logger.ts";
import { createObserver, type Direction } from "./observe.ts";

describe("createObserver", () => {
  test("records direction, kind, method and id of each message", () => {
    const { records } = observe([
      toServer({ id: 1, method: "thread/start", params: { cwd: "/w" } }),
      toApp({ method: "turn/started", params: { turnId: "t" } }),
      toApp({ id: 1, result: { thread: { id: "th" } } }),
      toApp({ id: "s-1", method: "item/tool/call", params: {} }),
      toServer({ id: "s-1", error: { code: -1, message: "denied" } }),
    ]);

    expect(records).toEqual([
      {
        event: "rpc_message",
        direction: "app_to_server",
        kind: "request",
        method: "thread/start",
        id: 1,
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
    ]);
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

  test("keeps params, results and errors out of the log", () => {
    const { log } = observe([
      toServer({
        id: 3,
        method: "turn/start",
        params: { input: [{ type: "text", text: PROMPT }], token: SECRET },
      }),
      toApp({ method: "item/agentMessage/delta", params: { delta: PROMPT } }),
      toApp({ id: 3, result: { apiKey: SECRET } }),
      toApp({ id: 4, error: { message: SECRET } }),
      toApp({
        id: "x",
        method: "item/tool/call",
        params: { arguments: SECRET },
      }),
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

  test("counts lines it cannot observe without logging their content", () => {
    const { log, records } = observe(
      [
        { direction: "app_to_server", line: `{"id":1,"method":"${SECRET}\n` },
        { direction: "app_to_server", line: `["${SECRET}"]\n` },
        { direction: "app_to_server", line: `{"secret":"${SECRET}"}\n` },
        {
          direction: "server_to_app",
          line: `{"id":1,"result":"${SECRET}${SECRET}"}\n`,
        },
        { direction: "server_to_app", line: "\n" },
      ],
      { maxLineBytes: 48 },
    );

    expect(records).toEqual([
      {
        event: "rpc_unobserved",
        direction: "app_to_server",
        reason: "invalid_json",
      },
      {
        event: "rpc_unobserved",
        direction: "app_to_server",
        reason: "not_object",
      },
      {
        event: "rpc_unobserved",
        direction: "app_to_server",
        reason: "unknown_shape",
      },
      {
        event: "rpc_unobserved",
        direction: "server_to_app",
        reason: "too_large",
      },
    ]);
    expect(log).not.toContain(SECRET);
  });

  test("observes messages split across chunks and the final unterminated line", () => {
    const methods: (string | null)[] = [];
    const observer = createObserver((event) => {
      if (event.event === "rpc_message") methods.push(event.method);
    });
    const encode = (text: string) => new TextEncoder().encode(text);
    observer.chunk("app_to_server", encode('{"id":1,"meth'));
    observer.chunk("app_to_server", encode('od":"a"}\n{"method":"b"}'));
    expect(methods).toEqual(["a"]);

    observer.end("app_to_server");

    expect(methods).toEqual(["a", "b"]);
  });
});

const SECRET = "sk-secret-token-0123";
const PROMPT = "private conversation text";

const observe = (
  messages: { direction: Direction; line: string }[],
  options: { maxLineBytes?: number } = {},
) => {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  const observer = createObserver(logger.log, options);
  for (const { direction, line } of messages) {
    observer.chunk(direction, new TextEncoder().encode(line));
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
