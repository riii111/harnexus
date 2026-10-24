import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isShapePath, shapeKey, shapeOf } from "./shape.ts";

describe("shapeOf", () => {
  test("names each field's path and type and keeps discriminator words", () => {
    const shape = shapeOf({
      id: 3,
      method: "item/started",
      params: {
        threadId: "th-1",
        item: { type: "commandExecution", command: "rm -rf ~/secret" },
        flags: [],
        error: null,
        text_elements: [{ start: 0 }],
      },
    });

    expect(shape).toEqual([
      "id:number",
      "method=item/started",
      "params.error:null",
      "params.flags:array",
      "params.item.command:string",
      "params.item.type=commandExecution",
      "params.text_elements[].start:number",
      "params.threadId:string",
    ]);
  });

  test.each([
    {
      name: "a path used as a key",
      value: { changes: { "/Users/someone/acme/notes.md": { kind: "add" } } },
      expected: ["changes.<key>:object"],
    },
    {
      name: "an environment variable name",
      value: { env: { ACME_TOKEN: "sk-123" } },
      expected: ["env.<key>:string"],
    },
    {
      name: "an MCP server name",
      value: { mcpServers: { acme: { command: "acme-mcp" } } },
      expected: ["mcpServers.<key>.command:string"],
    },
    {
      name: "free text in a discriminator",
      value: { status: "Failed: cannot open /Users/someone" },
      expected: ["status:string"],
    },
    {
      name: "a discriminator word with digits or a hyphen",
      value: { item: { type: "acme-2024", role: "sk123" } },
      expected: ["item.role:string", "item.type:string"],
    },
    {
      name: "tool arguments, whatever their keys and words",
      value: {
        item: {
          type: "mcpToolCall",
          arguments: { acmeCustomer: "x", status: "fireSomeone" },
          result: { structuredContent: { bobJones: { kind: "acme" } } },
        },
      },
      expected: [
        "item.arguments:object",
        "item.result.structuredContent:object",
        "item.type=mcpToolCall",
      ],
    },
    {
      name: "MCP result content and error data",
      value: {
        result: { content: [{ type: "acmePayroll", acmeSalary: 1 }] },
        error: { data: { kind: "confidential", acmeCustomerId: 1 } },
      },
      expected: ["error.data:object", "result.content:array"],
    },
    {
      name: "fields below a key that is not a field name",
      value: { _meta: { acmeTenant: { kind: "secretProject" } } },
      expected: ["<key>:object"],
    },
    {
      name: "a written configuration value",
      value: { edits: [{ value: { acme_azure: { env_key: "k" } } }] },
      expected: ["edits[].value:object"],
    },
    {
      name: "a word in an environment map entry",
      value: { params: { env: { role: "secretAlphabeticValue" } } },
      expected: ["params.env.<key>:string"],
    },
    {
      name: "a status word outside the places the protocol puts one",
      value: { params: { note: { status: "secretAlphabeticValue" } } },
      expected: ["params.note.status:string"],
    },
    {
      name: "configuration contents",
      value: { config: { model_providers: { acme_azure: { base_url: "u" } } } },
      expected: ["config:object"],
    },
  ])("hides $name", ({ value, expected }) => {
    const shape = shapeOf(value);

    expect(shape).toEqual([...expected]);
    expect(shape.join(" ")).not.toMatch(
      /someone|acme|sk-?123|bobJones|fire|confidential|secret/i,
    );
  });

  test("stays bounded on a huge or deeply nested message", () => {
    let deep: unknown = "end";
    for (let index = 0; index < 1000; index += 1) deep = { next: deep };
    const wide = Object.fromEntries(
      Array.from({ length: 5000 }, (_, index) => [`field${index}`, index]),
    );

    expect(shapeOf(deep).at(-1)).toEndWith(":deeper");
    expect(shapeOf(wide).length).toBeLessThanOrEqual(64);
  });
});

describe("isShapePath", () => {
  test.each([
    {
      name: "a field path",
      path: "params.items[].type=agentMessage",
      expected: true,
    },
    { name: "a map key", path: "env.<key>:string", expected: true },
    {
      name: "a file path",
      path: "/Users/someone/acme.md:string",
      expected: false,
    },
    { name: "a token after =", path: "x=ghp-ABCDEF123", expected: false },
    {
      name: "a word with digits after =",
      path: "a.type=Acme_Corp_2026",
      expected: false,
    },
    {
      name: "the root method",
      path: "method=codex/event/exec_command",
      expected: true,
    },
    { name: "an unknown type", path: "x:secret", expected: false },
  ])("tells $name", ({ path, expected }) => {
    expect(isShapePath(path)).toBe(expected);
  });
});

describe("shapeKey", () => {
  test("is the same for the same paths and differs otherwise", () => {
    expect(shapeKey(["a:string"])).toBe(shapeKey(["a:string"]));
    expect(shapeKey(["a:string"])).not.toBe(shapeKey(["a:number"]));
  });
});

describe("shapeOf fixtures", () => {
  test.each(
    readdirSync(FIXTURES)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => ({ name })),
  )("shapes every message of $name without its secret", ({ name }) => {
    const messages = readFileSync(join(FIXTURES, name), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line).message);

    for (const message of messages) {
      const shape = shapeOf(message);
      expect(shape.length).toBeGreaterThan(0);
      expect(shape.every(isShapePath)).toBe(true);
      expect(shape.join("\n")).not.toContain("sk-fixture-secret");
    }
  });
});

const FIXTURES = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "test",
  "fixtures",
  "app-server",
);
