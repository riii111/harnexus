import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppRequest } from "../turn/thread-request.ts";
import { createRouter, type RouteEvent } from "./route.ts";

describe("Codex threads", () => {
  // The lines of one session are replayed in order, so the loop inside is a scenario rather than a table.
  test.each<{ file: string; expected: number[] }>([
    { file: "handshake.jsonl", expected: [2] },
    { file: "turn-with-tools.jsonl", expected: [] },
    { file: "steer-and-interrupt.jsonl", expected: [] },
    { file: "turn-failed-with-edits.jsonl", expected: [] },
  ])("pass $file unchanged except the ids $expected of model list responses", ({
    file,
    expected,
  }) => {
    const { router } = setup();
    const changed: unknown[] = [];

    for (const { direction, line } of fixtureLines(file)) {
      const routed =
        direction === "app_to_server"
          ? router.fromApp(line)
          : router.fromServer(line);
      if (routed === null || !routed.equals(line)) {
        changed.push(JSON.parse(line.toString()).id);
      }
    }

    expect(changed).toEqual(expected);
  });

  // The fixtures already carry turn/start, turn/interrupt and turn/steer; review/start shares its branch with compaction.
  test("leave review/start of a Codex thread to the server", () => {
    const { router, calls } = setup();
    const line = encode({
      id: 5,
      method: "review/start",
      params: { threadId: "codex" },
    });

    expect(router.fromApp(line)).toEqual(line);
    expect(calls).toEqual([]);
  });
});

describe("turn/start of a thread created by create_thread", () => {
  test("reports the thread that asked for it and still passes the line to the server", () => {
    const { router, calls } = setup();
    const line = encode({
      id: 7,
      method: "turn/start",
      params: {
        threadId: "th-reviewer",
        input: [],
        toolOutput: {
          name: "create_thread",
          namespace: "codex_app",
          output:
            "<codex_delegation>\n  <source_thread_id>th-claude</source_thread_id>\n</codex_delegation>",
        },
      },
    });

    const routed = router.fromApp(line);

    expect(routed).toBe(line);
    expect(calls).toEqual([["delegated", "th-claude", "th-reviewer"]]);
  });

  test("reports nothing for another tool's output", () => {
    const { router, calls } = setup();

    router.fromApp(
      encode({
        id: 7,
        method: "turn/start",
        params: {
          threadId: "th-other",
          input: [],
          toolOutput: {
            name: "fork_thread",
            output: "<source_thread_id>th-claude</source_thread_id>",
          },
        },
      }),
    );

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

  test.each([
    { method: "turn/start", expected: "startTurn" },
    { method: "turn/interrupt", expected: "interruptTurn" },
    { method: "turn/steer", expected: "steerTurn" },
    { method: "review/start", expected: "reject" },
    { method: "thread/compact/start", expected: "reject" },
  ])("hands $method of a Claude thread to $expected instead of the server", ({
    method,
    expected,
  }) => {
    const { router, calls } = setup(["th-claude"]);
    const line = encode({ id: 6, method, params: { threadId: "th-claude" } });

    expect(router.fromApp(line)).toBeNull();
    expect(calls.map(([name]) => name)).toEqual([expected]);
  });

  test("refuses a resume of a Claude thread in another working directory", () => {
    const { router, calls, events } = setup(["th-claude"]);
    const line = encode({
      id: 4,
      method: "thread/resume",
      params: { threadId: "th-claude", cwd: "/elsewhere" },
    });

    expect(router.fromApp(line)).toBeNull();
    expect(calls.map(([name]) => name)).toEqual(["reject"]);
    expect(events).toEqual([
      {
        event: "claude_request_refused",
        method: "thread/resume",
        reason: "directory_change",
      },
    ]);
  });

  test("moves a resumed Claude thread to the Claude model it names and hides it from the server", () => {
    const { router, calls } = setup(["th-claude"]);

    const forwarded = router.fromApp(
      encode({
        id: 4,
        method: "thread/resume",
        params: { threadId: "th-claude", model: OTHER_CLAUDE },
      }),
    );
    const out = parse(router.fromServer(threadResponse(4, "th-claude")));

    expect(parse(forwarded).params).toEqual({ threadId: "th-claude" });
    expect(calls).toEqual([["changeModel", "th-claude", OTHER_CLAUDE]]);
    expect(out.result.model).toBe(OTHER_CLAUDE);
  });

  test("forwards a resume of a Claude thread in its own directory", () => {
    const { router, calls } = setup(["th-claude"]);
    const line = encode({
      id: 4,
      method: "thread/resume",
      params: { threadId: "th-claude", cwd: "/fixture/work/" },
    });

    expect(router.fromApp(line)).toEqual(line);
    expect(calls).toEqual([]);
  });

  test("reads the model of a turn from its collaboration mode when the request has no model", () => {
    const { router, calls } = setup();
    const line = encode({
      id: 7,
      method: "turn/start",
      params: {
        threadId: "th-codex",
        cwd: "/fixture/work",
        collaborationMode: { mode: "default", settings: { model: CLAUDE } },
      },
    });

    expect(router.fromApp(line)).toBeNull();
    expect(calls.map(([name]) => name)).toEqual(["startTurn"]);
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

describe("thread/settings/update", () => {
  test("drops a Claude thread's own model before the server sees it", () => {
    const { router, calls } = setup(["th-claude"]);

    const forwarded = router.fromApp(
      settingsUpdate({
        model: CLAUDE,
        collaborationMode: { mode: "default", settings: { model: CLAUDE } },
        approvalPolicy: "never",
      }),
    );

    expect(parse(forwarded).params).toEqual({
      threadId: "th-claude",
      approvalPolicy: "never",
    });
    expect(calls).toEqual([]);
  });

  // The app sends its previous collaboration mode along with the model just picked, as observed with App 26.924.
  test("keeps the thread's model picked again over a stale collaboration mode", () => {
    const { router, calls } = setup(["th-claude"]);

    const forwarded = router.fromApp(
      settingsUpdate({
        model: CLAUDE,
        collaborationMode: {
          mode: "default",
          settings: { model: OTHER_CLAUDE },
        },
      }),
    );

    expect(parse(forwarded).params).toEqual({ threadId: "th-claude" });
    expect(calls).toEqual([]);
  });

  test.each([
    { name: "alone", change: { model: OTHER_CLAUDE } },
    {
      name: "beside a stale collaboration mode",
      change: {
        model: OTHER_CLAUDE,
        collaborationMode: { mode: "default", settings: { model: CLAUDE } },
      },
    },
  ])("moves a Claude thread to another Claude model picked $name without telling the server", ({
    change,
  }) => {
    const { router, calls } = setup(["th-claude"]);

    const forwarded = router.fromApp(settingsUpdate(change));

    expect(parse(forwarded).params).toEqual({ threadId: "th-claude" });
    expect(calls).toEqual([["changeModel", "th-claude", OTHER_CLAUDE]]);
  });

  test.each([
    {
      name: "a Codex model in the collaboration mode alone",
      change: {
        collaborationMode: { mode: "default", settings: { model: "gpt-x" } },
      },
    },
    {
      name: "plan mode",
      change: {
        collaborationMode: { mode: "plan", settings: { model: CLAUDE } },
      },
    },
    { name: "another working directory", change: { cwd: "/elsewhere" } },
  ])("refuses $name on a Claude thread", ({ change }) => {
    const { router, calls } = setup(["th-claude"]);

    expect(router.fromApp(settingsUpdate(change))).toBeNull();
    expect(calls.map(([name]) => name)).toEqual(["reject"]);
  });

  test("switches a Codex thread to Claude without telling the server", () => {
    const { router, calls } = setup();

    router.fromApp(
      encode({
        id: 3,
        method: "thread/start",
        params: { cwd: "/fixture/work" },
      }),
    );
    router.fromServer(threadResponse(3, "th-claude"));
    const forwarded = router.fromApp(settingsUpdate({ model: CLAUDE }));

    expect(parse(forwarded).params).toEqual({ threadId: "th-claude" });
    expect(calls).toEqual([
      ["adopt", "th-claude", { model: CLAUDE, cwd: "/fixture/work" }],
    ]);
  });

  test("leaves a Codex thread's settings to the server", () => {
    const { router } = setup();
    const line = settingsUpdate({ model: "gpt-fixture" });

    expect(router.fromApp(line)).toEqual(line);
  });

  test("reports the Claude model on resume even when the history mentions the settings notice", () => {
    const { router } = setup(["th-claude"]);

    router.fromApp(
      encode({
        id: 4,
        method: "thread/resume",
        params: { threadId: "th-claude" },
      }),
    );
    const response = parse(threadResponse(4, "th-claude"));
    response.result.thread.preview = "about thread/settings/updated";
    const out = parse(router.fromServer(encode(response)));

    expect(out.result.model).toBe(CLAUDE);
  });

  test("forwards the same directory spelled with a trailing slash", () => {
    const { router, calls } = setup(["th-claude"]);
    const line = settingsUpdate({ cwd: "/fixture/work/" });

    expect(router.fromApp(line)).toEqual(line);
    expect(calls).toEqual([]);
  });

  test("reports the Claude model in the server's settings notice", () => {
    const { router } = setup(["th-claude"]);
    const notice = encode({
      method: "thread/settings/updated",
      params: {
        threadId: "th-claude",
        threadSettings: {
          model: "gpt-fixture",
          collaborationMode: {
            mode: "default",
            settings: { model: "gpt-fixture" },
          },
        },
      },
    });

    const out = parse(router.fromServer(notice));

    expect(out.params.threadSettings.model).toBe(CLAUDE);
    expect(out.params.threadSettings.collaborationMode.settings.model).toBe(
      CLAUDE,
    );
  });
});

const CLAUDE = "claude-sonnet-5";
const OTHER_CLAUDE = "claude-opus-5-5";

const settingsUpdate = (change: object) =>
  encode({
    id: 8,
    method: "thread/settings/update",
    params: { threadId: "th-claude", ...change },
  });

const setup = (claudeThreads: string[] = []) => {
  const calls: unknown[][] = [];
  const events: RouteEvent[] = [];
  const threads = new Map(
    claudeThreads.map((id) => [id, { model: CLAUDE, cwd: "/fixture/work" }]),
  );
  const router = createRouter(
    {
      isClaudeThread: (threadId) =>
        typeof threadId === "string" && threads.has(threadId),
      threadOf: (threadId) => threads.get(threadId),
      adopt: (threadId, thread) => {
        calls.push(["adopt", threadId, thread]);
        threads.set(threadId, thread);
      },
      changeModel: (threadId, model) => {
        calls.push(["changeModel", threadId, model]);
        const thread = threads.get(threadId);
        if (thread !== undefined) threads.set(threadId, { ...thread, model });
      },
      startTurn: (request: AppRequest, cwd) =>
        calls.push(["startTurn", request, cwd]),
      steerTurn: (request) => calls.push(["steerTurn", request]),
      interruptTurn: (request) => calls.push(["interruptTurn", request]),
      reject: (request, message) => calls.push(["reject", request, message]),
    },
    (event) => events.push(event),
    (source, threadId) => calls.push(["delegated", source, threadId]),
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
