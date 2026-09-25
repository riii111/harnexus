import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppRequest } from "../turn/controller.ts";
import { createRouter, type RouteEvent } from "./route.ts";

describe("Codex threads", () => {
  test("pass every fixture line unchanged except the model list response", () => {
    const { router } = setup();
    const changed: string[] = [];

    for (const file of FIXTURES) {
      for (const { direction, line } of fixtureLines(file)) {
        const routed =
          direction === "app_to_server"
            ? router.fromApp(line)
            : router.fromServer(line);
        if (routed === null || !routed.equals(line)) {
          changed.push(`${file} ${JSON.parse(line.toString()).id}`);
        }
      }
    }

    expect(changed).toEqual(["handshake.jsonl 2"]);
  });

  test("leave turn requests of a Codex thread to the server", () => {
    const { router, calls } = setup();

    for (const method of ["turn/start", "turn/interrupt", "turn/steer"]) {
      const line = encode({ id: 5, method, params: { threadId: "codex" } });
      expect(router.fromApp(line)).toEqual(line);
    }
    expect(calls).toEqual([]);
  });
});

describe("model/list", () => {
  test("appends the Claude models to the last page", () => {
    const { router } = setup();

    router.fromApp(encode({ id: 2, method: "model/list", params: {} }));
    const out = parse(router.fromServer(modelList(2, null)));

    expect(out.result.data.map((model: { id: string }) => model.id)).toEqual([
      "gpt-fixture",
      "claude-opus-5-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
    expect(out.result.data[1]).toMatchObject({
      model: "claude-opus-5-5",
      hidden: false,
      isDefault: false,
    });
  });

  test("leaves earlier pages alone", () => {
    const { router } = setup();

    router.fromApp(encode({ id: 2, method: "model/list", params: {} }));
    const line = modelList(2, "next");

    expect(router.fromServer(line)).toEqual(line);
  });

  test("logs a Claude id the server already lists instead of adding it twice", () => {
    const { router, events } = setup();

    router.fromApp(encode({ id: 2, method: "model/list", params: {} }));
    const out = parse(
      router.fromServer(modelList(2, null, ["gpt-fixture", "claude-sonnet-5"])),
    );

    const ids = out.result.data.map((model: { id: string }) => model.id);
    expect(ids.filter((id: string) => id === "claude-sonnet-5")).toHaveLength(
      1,
    );
    expect(events).toEqual([
      { event: "model_id_collision", model: "claude-sonnet-5" },
    ]);
  });

  test("does not read a server request that reuses the pending id", () => {
    const { router } = setup();

    router.fromApp(encode({ id: 0, method: "model/list", params: {} }));
    const request = encode({ id: 0, method: "item/tool/call", params: {} });

    expect(router.fromServer(request)).toEqual(request);
  });
});

describe("threads with a Claude model", () => {
  test("creates the thread on the server's default model and reports the Claude one", () => {
    const { router, calls } = setup();

    const forwarded = router.fromApp(
      encode({
        id: 3,
        method: "thread/start",
        params: { cwd: "/fixture/work", model: CLAUDE },
      }),
    );
    const out = parse(router.fromServer(threadResponse(3, "th-new")));

    expect(parse(forwarded).params).toEqual({ cwd: "/fixture/work" });
    expect(calls).toEqual([
      ["adopt", "th-new", { model: CLAUDE, cwd: "/fixture/work" }],
    ]);
    expect(out.result.model).toBe(CLAUDE);
    expect(out.result.thread.model).toBe(CLAUDE);
  });

  test("reports the Claude model when a Claude thread is resumed", () => {
    const { router } = setup(["th-claude"]);

    router.fromApp(
      encode({
        id: 4,
        method: "thread/resume",
        params: { threadId: "th-claude" },
      }),
    );
    const out = parse(router.fromServer(threadResponse(4, "th-claude")));

    expect(out.result.model).toBe(CLAUDE);
  });

  test("hands turn requests of a Claude thread to the turn controller", () => {
    const { router, calls } = setup(["th-claude"]);

    for (const method of ["turn/start", "turn/interrupt", "turn/steer"]) {
      const line = encode({ id: 6, method, params: { threadId: "th-claude" } });
      expect(router.fromApp(line)).toBeNull();
    }
    expect(calls.map(([name]) => name)).toEqual([
      "startTurn",
      "interruptTurn",
      "refuseSteer",
    ]);
  });

  test("switches a Codex thread by turn/start with the directory the server reported", () => {
    const { router, calls } = setup();

    router.fromApp(
      encode({
        id: 3,
        method: "thread/start",
        params: { cwd: "/fixture/work" },
      }),
    );
    router.fromServer(threadResponse(3, "th-codex"));
    const routed = router.fromApp(
      encode({
        id: 7,
        method: "turn/start",
        params: { threadId: "th-codex", model: CLAUDE, input: [] },
      }),
    );

    expect(routed).toBeNull();
    expect(calls).toEqual([
      [
        "startTurn",
        { id: 7, params: { threadId: "th-codex", model: CLAUDE, input: [] } },
        "/fixture/work",
      ],
    ]);
  });
});

const CLAUDE = "claude-sonnet-5";

const FIXTURES = [
  "handshake.jsonl",
  "turn-with-tools.jsonl",
  "steer-and-interrupt.jsonl",
  "turn-failed-with-edits.jsonl",
];

const setup = (claudeThreads: string[] = []) => {
  const calls: unknown[][] = [];
  const events: RouteEvent[] = [];
  const models = new Map(claudeThreads.map((id) => [id, CLAUDE]));
  const router = createRouter(
    {
      isClaudeThread: (threadId) =>
        typeof threadId === "string" && models.has(threadId),
      modelOf: (threadId) => models.get(threadId),
      adopt: (threadId, thread) => {
        calls.push(["adopt", threadId, thread]);
        models.set(threadId, thread.model);
      },
      startTurn: (request: AppRequest, cwd) =>
        calls.push(["startTurn", request, cwd]),
      interruptTurn: (request) => calls.push(["interruptTurn", request]),
      refuseSteer: (request) => calls.push(["refuseSteer", request]),
    },
    (event) => events.push(event),
  );
  return { router, calls, events };
};

const fixtureLines = (file: string) =>
  readFileSync(join(FIXTURE_DIR, file), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const record = JSON.parse(line);
      return {
        direction: record.direction as string,
        line: encode(record.message),
      };
    });

const modelList = (
  id: number,
  nextCursor: string | null,
  ids = ["gpt-fixture"],
) =>
  encode({
    id,
    result: { data: ids.map((model) => ({ id: model, model })), nextCursor },
  });

const threadResponse = (id: number, threadId: string) =>
  encode({
    id,
    result: {
      thread: { id: threadId, model: "gpt-fixture", cwd: "/fixture/work" },
      model: "gpt-fixture",
      cwd: "/fixture/work",
    },
  });

const encode = (message: object) => Buffer.from(`${JSON.stringify(message)}\n`);

const parse = (line: Buffer | null) => JSON.parse(line?.toString() ?? "null");

const FIXTURE_DIR = join(import.meta.dir, "../../test/fixtures/app-server");
