import { describe, expect, test } from "bun:test";
import {
  diffShapes,
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
          recorded: 2,
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
        recorded: 1,
        added: [],
        filled: [],
        missing: [{ path: "params.turn.rootTurnId:string", lackedBy: 1 }],
      },
    ]);
  });

  test("names a field one recorded shape lacks even when another has it", () => {
    const diff = diffShapes(
      [
        shape("turn/started", [
          "params.threadId:string",
          "params.turn.id:string",
        ]),
        shape("turn/started", ["params.turn.id:string"]),
      ],
      [
        shape("turn/started", [
          "params.threadId:string",
          "params.turn.id:string",
        ]),
      ],
    );

    expect(diff.changed[0]?.missing).toEqual([
      { path: "params.threadId:string", lackedBy: 1 },
    ]);
    expect(formatProtocol(diff, 10_000).join("\n")).toContain(
      "missing params.threadId:string (in 1 of 2 recorded shapes)",
    );
  });

  test("lists a changed shape even when another method's fixture has the same paths", () => {
    const diff = diffShapes(
      [shape("turn/start", ["id:number", "params.mode:string"])],
      [
        shape("turn/start", ["id:number"]),
        shape("thread/start", ["id:number", "params.mode:string"]),
      ],
    );

    expect(diff.unseen).toEqual([
      shape("turn/start", ["id:number", "params.mode:string"]),
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
          recorded: 1,
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

const shape = (method: string, paths: string[]): RecordedShape => ({
  direction: "app_to_server",
  kind: "request",
  method,
  paths,
});
