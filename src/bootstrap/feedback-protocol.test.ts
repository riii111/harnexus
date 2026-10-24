import { describe, expect, test } from "bun:test";
import {
  diffShapes,
  fixtureFromReport,
  fixtureShapes,
  formatProtocol,
  type RecordedShape,
} from "./feedback-protocol.ts";

describe("fixtureShapes", () => {
  test("shapes a response under the method of the request it answers", () => {
    const shapes = fixtureShapes([
      {
        direction: "app_to_server",
        message: { id: 1, method: "thread/start", params: { cwd: "/w" } },
      },
      {
        direction: "server_to_app",
        message: { id: 1, result: { thread: { id: "th" } } },
      },
    ]);

    expect(shapes).toEqual([
      {
        direction: "app_to_server",
        kind: "request",
        method: "thread/start",
        paths: ["id:number", "method=thread/start", "params.cwd:string"],
      },
      {
        direction: "server_to_app",
        kind: "response",
        method: "thread/start",
        paths: ["id:number", "result.thread.id:string"],
      },
    ]);
  });
});

describe("diffShapes", () => {
  test("names new fields and lists methods the fixtures do not hold", () => {
    const diff = diffShapes(
      [
        shape("turn/start", ["id:number", "params.text:string"]),
        shape("turn/start", [
          "id:number",
          "params.mode:string",
          "params.text:string",
        ]),
        shape("config/read", ["id:number"]),
      ],
      [shape("turn/start", ["id:number", "params.text:string"])],
    );

    expect(diff).toEqual({
      covered: 1,
      methods: 2,
      changed: [
        {
          method: "app_to_server request turn/start (no type)",
          added: ["params.mode:string"],
          filled: [],
          missing: [],
        },
      ],
      newVariants: [],
      uncovered: ["app_to_server request config/read"],
      unseen: [
        shape("turn/start", [
          "id:number",
          "params.mode:string",
          "params.text:string",
        ]),
      ],
    });
  });

  test("names a field every fixture shape has and no recorded one does", () => {
    const diff = diffShapes(
      [shape("turn/started", ["params.turn.id:string"])],
      [
        shape("turn/started", [
          "params.turn.id:string",
          "params.turn.rootTurnId:string",
        ]),
        shape("turn/started", [
          "params.turn.id:string",
          "params.turn.items:array",
          "params.turn.rootTurnId:string",
        ]),
      ],
    );

    expect(diff.changed).toEqual([
      {
        method: "app_to_server request turn/started (no type)",
        added: [],
        filled: [],
        missing: ["params.turn.rootTurnId:string"],
      },
    ]);
  });

  test("compares each variant with the fixtures of that variant only", () => {
    const diff = diffShapes(
      [
        shape("item/started", [
          "params.item.durationMs:number",
          "params.item.type=agentMessage",
        ]),
        shape("item/started", ["params.item.type=reasoning"]),
      ],
      [
        shape("item/started", ["params.item.type=agentMessage"]),
        shape("item/started", [
          "params.item.durationMs:number",
          "params.item.type=commandExecution",
        ]),
      ],
    );

    expect(
      diff.changed.map(({ method, added }) => ({ method, added })),
    ).toEqual([
      {
        method:
          "app_to_server request item/started params.item.type=agentMessage",
        added: ["params.item.durationMs:number"],
      },
    ]);
    expect(diff.newVariants).toEqual([
      "app_to_server request item/started params.item.type=reasoning",
    ]);
  });

  test("compares nested type words as fields of the variant", () => {
    const diff = diffShapes(
      [
        shape("item/started", [
          "params.item.commandActions[].type=read",
          "params.item.newField:number",
          "params.item.type=commandExecution",
        ]),
      ],
      [
        shape("item/started", [
          "params.item.commandActions[].type=listFiles",
          "params.item.type=commandExecution",
        ]),
      ],
    );

    expect(diff.newVariants).toEqual([]);
    expect(diff.changed[0]?.added).toEqual([
      "params.item.commandActions[].type=read",
      "params.item.newField:number",
    ]);
  });

  test("tells a field the fixtures hold only empty or null from a new one", () => {
    const diff = diffShapes(
      [
        shape("turn/completed", [
          "params.error.message:string",
          "params.items[].id:string",
        ]),
      ],
      [shape("turn/completed", ["params.error:null", "params.items:array"])],
    );

    expect(diff.changed[0]).toMatchObject({
      added: [],
      filled: ["params.error.message:string", "params.items[].id:string"],
      missing: [],
    });
  });

  test("reports nothing changed when every field is in the fixtures", () => {
    const diff = diffShapes(
      [shape("turn/start", ["id:number"])],
      [shape("turn/start", ["id:number"])],
    );

    expect(diff.changed).toEqual([]);
    expect(diff.unseen).toEqual([]);
  });
});

describe("formatProtocol", () => {
  test("keeps every line within the budget, however many fields and methods differ", () => {
    const many = Array.from(
      { length: 500 },
      (_, index) => `params.f${index}:string`,
    );

    const lines = formatProtocol(
      {
        covered: 1,
        methods: 400,
        changed: Array.from({ length: 50 }, (_, index) => ({
          method: `app_to_server request m${index}`,
          added: many,
          filled: [],
          missing: [],
        })),
        newVariants: [],
        uncovered: Array.from({ length: 400 }, (_, index) => `method/${index}`),
        unseen: Array.from({ length: 30 }, () => shape("m0", many)),
      },
      2000,
    );

    expect(lines.join("\n").length).toBeLessThanOrEqual(2100);
    expect(lines[1]).toContain("and 480 more");
    expect(lines.at(-1)).toMatch(/^\d+ more lines left out to fit an issue$/);
  });
});

describe("fixtureFromReport", () => {
  test("turns the shapes a report lists into fixture lines the observer shapes the same way", () => {
    const notification = {
      direction: "server_to_app",
      kind: "notification",
      method: "item/started",
      paths: [
        "method=item/started",
        "params.item.type=newThing",
        "params.x:number",
      ],
    };
    const response = {
      direction: "server_to_app",
      kind: "response",
      method: "thread/start",
      paths: ["id:number", "result.thread.id:string"],
    };
    const report = `== Protocol ==\nsome text\n${JSON.stringify(notification)}\n${JSON.stringify(response)}\n{not json\n`;

    const fixture = fixtureFromReport(report)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(fixture).toHaveLength(3);
    expect(fixture.map(({ message }) => message.id)).toEqual([
      undefined,
      9001,
      9001,
    ]);
    expect(
      fixtureShapes(fixture).filter(
        ({ direction }) => direction === "server_to_app",
      ),
    ).toEqual([notification, response]);
  });
});

describe("fixtureFromReport input", () => {
  test("keeps a long method and skips paths that are not shape paths", () => {
    const line = JSON.stringify({
      direction: "server_to_app",
      kind: "notification",
      method: "codex/event/exec_command_output_delta/x/y/z",
      paths: [
        "method:string",
        "params.chunk:string",
        "/Users/someone/file:string",
        "__proto__.polluted:string",
      ],
    });

    const [record] = fixtureFromReport(line)
      .trim()
      .split("\n")
      .map((text) => JSON.parse(text));

    expect(record).toEqual({
      direction: "server_to_app",
      message: {
        method: "codex/event/exec_command_output_delta/x/y/z",
        params: { chunk: "x" },
      },
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

const shape = (method: string, paths: string[]): RecordedShape => ({
  direction: "app_to_server",
  kind: "request",
  method,
  paths,
});
