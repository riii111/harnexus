import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  EffortLevel,
  SDKMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Result } from "better-result";
import {
  createModelCatalog,
  effortRule,
  isClaudeEffort,
} from "../infra/claude/models.ts";
import { readClaudeSession } from "../infra/claude/session.ts";
import {
  conversation,
  prompt,
  reply,
  text,
} from "../presentation/testing/session-record.ts";
import { createHistoryRequests } from "./history-request.ts";
import { createRouter, type RouteEvent } from "./route.ts";
import { createSubagentRequests } from "./subagent-requests.ts";
import { createSubagents } from "./subagents.ts";
import type { AppRequest, Mode } from "./thread-request.ts";

describe("Codex threads", () => {
  // The lines of one session are replayed in order, so the loop inside is a scenario rather than a table.
  test.each<{ file: string; expected: number[] }>([
    { file: "handshake.jsonl", expected: [2] },
    { file: "turn-with-tools.jsonl", expected: [] },
    { file: "steer-and-interrupt.jsonl", expected: [] },
    { file: "turn-failed-with-edits.jsonl", expected: [] },
  ])("pass $file unchanged except the ids $expected of model list responses", async ({
    file,
    expected,
  }) => {
    const { router } = setup();
    const changed: unknown[] = [];

    for (const { direction, line } of fixtureLines(file)) {
      const routed =
        direction === "app_to_server"
          ? router.fromApp(line)
          : await router.fromServer(line);
      if (routed === null || !routed.equals(line)) {
        changed.push(JSON.parse(line.toString()).id);
      }
    }

    expect(changed).toEqual(expected);
  });

  // The fixtures already carry turn/start, turn/interrupt and turn/steer.
  test.each([
    { method: "review/start" },
    { method: "thread/compact/start" },
  ])("leave $method of a Codex thread to the server", ({ method }) => {
    const { router, calls } = setup(["th-claude"]);
    const line = encode({ id: 5, method, params: { threadId: "codex" } });

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

describe("Codex CLI version", () => {
  test.each([
    {
      name: "a verified version",
      agent: "Codex Desktop/0.158.0-alpha.2.1 (Mac OS 26.5.1; arm64)",
      expected: { version: "0.158.0-alpha.2.1", verified: true },
    },
    {
      name: "another version",
      agent: "Codex Desktop/0.159.0 (Mac OS 26.5.1; arm64)",
      expected: { version: "0.159.0", verified: false },
    },
    {
      name: "the observed agent with a client suffix",
      agent:
        "probe/0.158.0-alpha.2.1 (Mac OS 26.5.1; arm64) unknown (probe; 0.0.0)",
      expected: { version: "0.158.0-alpha.2.1", verified: true },
    },
    {
      name: "a client name with a slash",
      agent: "Codex/Desktop/0.158.0-alpha.2.1 (Mac OS 26.5.1; arm64)",
      expected: { version: "0.158.0-alpha.2.1", verified: true },
    },
    {
      name: "an agent without a version",
      agent: "unknown",
      expected: { version: null, verified: false },
    },
  ])("logs $name from the initialize answer and passes it on as the same bytes", async ({
    agent,
    expected,
  }) => {
    const { router, events } = setup();
    const answer = initializeAnswer(agent);

    router.fromApp(encode({ id: 1, method: "initialize", params: {} }));
    const out = await router.fromServer(answer);

    expect(out).toEqual(answer);
    expect(events).toEqual([{ event: "codex_version", ...expected }]);
  });

  test.each<{
    name: string;
    agent: string;
    policy: "warn" | "pause";
    expected: { models: number; unchanged: boolean };
  }>([
    {
      name: "an unverified version unless asked to pause",
      agent: UNVERIFIED_AGENT,
      policy: "warn",
      expected: { models: 7, unchanged: false },
    },
    {
      name: "an unverified version when asked to pause",
      agent: UNVERIFIED_AGENT,
      policy: "pause",
      expected: { models: 1, unchanged: true },
    },
    {
      name: "a verified version even when asked to pause",
      agent: VERIFIED_AGENT,
      policy: "pause",
      expected: { models: 7, unchanged: false },
    },
  ])("appends the Claude models to model/list only as allowed on $name", async ({
    agent,
    policy,
    expected,
  }) => {
    const { router } = setup([], {}, policy);
    router.fromApp(encode({ id: 1, method: "initialize", params: {} }));
    await router.fromServer(initializeAnswer(agent));
    router.fromApp(encode({ id: 2, method: "model/list", params: {} }));
    const line = modelList(2, null);

    const out = await router.fromServer(line);

    expect({
      models: parse(out).result.data.length,
      unchanged: out?.equals(line),
    }).toEqual(expected);
  });

  test.each([
    {
      name: "turn/start of a Claude thread",
      id: 6,
      method: "turn/start",
      params: { threadId: "th-claude" },
    },
    {
      name: "turn/steer of a Claude thread",
      id: 6,
      method: "turn/steer",
      params: { threadId: "th-claude" },
    },
    {
      name: "thread/compact/start of a Claude thread",
      id: 6,
      method: "thread/compact/start",
      params: { threadId: "th-claude" },
    },
    {
      name: "thread/start on a Claude model",
      id: 3,
      method: "thread/start",
      params: { cwd: "/fixture/work", model: CLAUDE },
    },
  ])("refuses $name with the reason while paused", async ({
    id,
    method,
    params,
  }) => {
    const { router, calls, events } = setup(["th-claude"], {}, "pause");
    router.fromApp(encode({ id: 1, method: "initialize", params: {} }));
    await router.fromServer(initializeAnswer(UNVERIFIED_AGENT));

    const routed = router.fromApp(encode({ id, method, params }));

    expect(routed).toBeNull();
    expect(calls).toEqual([
      ["reject", { id, params }, expect.stringContaining("paused")],
    ]);
    expect(events).toContainEqual({
      event: "claude_request_refused",
      method,
      reason: "claude_paused",
    });
  });

  test("runs a Claude turn on a verified version even when asked to pause", async () => {
    const { router, calls } = setup(["th-claude"], {}, "pause");
    router.fromApp(encode({ id: 1, method: "initialize", params: {} }));
    await router.fromServer(initializeAnswer(VERIFIED_AGENT));

    router.fromApp(
      encode({
        id: 6,
        method: "turn/start",
        params: { threadId: "th-claude" },
      }),
    );

    expect(calls.map(([name]) => name)).toEqual(["startTurn"]);
  });
});

describe("model/list", () => {
  test("appends the Claude models to the last page and leaves the levels of the server's models alone", async () => {
    const { router } = setup();
    const levels = [{ reasoningEffort: "ultra", description: "fixture" }];

    router.fromApp(encode({ id: 2, method: "model/list", params: {} }));
    const out = parse(
      await router.fromServer(
        encode({
          id: 2,
          result: {
            data: [{ id: "gpt-fixture", supportedReasoningEfforts: levels }],
            nextCursor: null,
          },
        }),
      ),
    );

    expect(out.result.data.map((model: { id: string }) => model.id)).toEqual([
      "gpt-fixture",
      "claude-opus-5-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "claude-opus-5-5~vertex",
      "claude-sonnet-5~vertex",
      "claude-haiku-4-5~vertex",
    ]);
    expect(out.result.data[4]).toMatchObject({
      model: "claude-opus-5-5~vertex",
      displayName: "Claude Opus 5.5 · Vertex AI",
      hidden: true,
    });
    expect(out.result.data[1]).toMatchObject({
      model: "claude-opus-5-5",
      hidden: false,
      isDefault: false,
    });
    expect(out.result.data[0]).toEqual({
      id: "gpt-fixture",
      supportedReasoningEfforts: levels,
    });
  });

  test.each([
    {
      name: "with effort",
      model: "claude-opus-5-5",
      expected: {
        levels: ["low", "medium", "high", "xhigh", "max"],
        default: "high",
      },
    },
    {
      name: "without effort",
      model: "claude-haiku-4-5",
      expected: { levels: ["medium"], default: "medium" },
    },
  ])("lists the levels and the default of a Claude model $name", async ({
    model,
    expected,
  }) => {
    const { router } = setup();

    router.fromApp(encode({ id: 2, method: "model/list", params: {} }));
    const out = parse(await router.fromServer(modelList(2, null)));

    const entry = out.result.data.find(
      (listed: { id: string }) => listed.id === model,
    );
    expect({
      levels: entry.supportedReasoningEfforts.map(
        (level: { reasoningEffort: string }) => level.reasoningEffort,
      ),
      default: entry.defaultReasoningEffort,
    }).toEqual(expected);
  });

  test("shows the Vertex AI models in the picker only when they are switched on", async () => {
    const { router } = setup([], {}, "warn", false, true);

    router.fromApp(encode({ id: 2, method: "model/list", params: {} }));
    const out = parse(await router.fromServer(modelList(2, null)));

    expect(
      out.result.data
        .filter((model: { id: string }) => model.id.endsWith("~vertex"))
        .map((model: { displayName: string; hidden: boolean }) => [
          model.displayName,
          model.hidden,
        ]),
    ).toEqual([
      ["Claude Opus 5.5 · Vertex AI", false],
      ["Claude Sonnet 5 · Vertex AI", false],
      ["Claude Haiku 4.5 · Vertex AI", false],
    ]);
  });

  test("lists the models Claude Code offers once read and a dropped built-in model as hidden", async () => {
    const { router, catalog } = setup();
    catalog.replace([
      {
        id: "claude-sonnet-5-5",
        displayName: "Claude Sonnet 5.5",
        description: "Sonnet 5.5 · Efficient for routine tasks",
        efforts: ["low", "high"],
      },
    ]);

    router.fromApp(encode({ id: 2, method: "model/list", params: {} }));
    const out = parse(await router.fromServer(modelList(2, null)));

    expect(
      out.result.data.map((model: { id: string; hidden: boolean }) => [
        model.id,
        model.hidden,
      ]),
    ).toEqual([
      ["gpt-fixture", undefined],
      ["claude-sonnet-5-5", false],
      ["claude-opus-5-5", true],
      ["claude-sonnet-5", true],
      ["claude-haiku-4-5", true],
      ["claude-sonnet-5-5~vertex", true],
      ["claude-opus-5-5~vertex", true],
      ["claude-sonnet-5~vertex", true],
      ["claude-haiku-4-5~vertex", true],
    ]);
    expect(out.result.data[1]).toMatchObject({
      displayName: "Claude Sonnet 5.5",
      description: "Sonnet 5.5 · Efficient for routine tasks",
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "high" },
      ],
      defaultReasoningEffort: "high",
    });
  });

  test("leaves earlier pages alone", () => {
    const { router } = setup();

    router.fromApp(encode({ id: 2, method: "model/list", params: {} }));
    const line = modelList(2, "next");

    expect(router.fromServer(line)).toEqual(line);
  });

  test("logs a server model with a Claude id and adds an already listed one only once", async () => {
    const { router, events } = setup();

    router.fromApp(encode({ id: 2, method: "model/list", params: {} }));
    const out = parse(
      await router.fromServer(
        modelList(2, null, ["gpt-fixture", "claude-sonnet-5", "claude-custom"]),
      ),
    );

    const ids = out.result.data.map((model: { id: string }) => model.id);
    expect(ids.filter((id: string) => id === "claude-sonnet-5")).toHaveLength(
      1,
    );
    expect(events).toEqual([
      { event: "model_id_collision", model: "claude-sonnet-5" },
      { event: "model_id_collision", model: "claude-custom" },
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
  test("creates the thread on the server's default model and reports the Claude one", async () => {
    const { router, calls } = setup();

    const forwarded = router.fromApp(
      encode({
        id: 3,
        method: "thread/start",
        params: { cwd: "/fixture/work", model: CLAUDE },
      }),
    );
    const out = parse(await router.fromServer(threadResponse(3, "th-new")));

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
    { method: "thread/compact/start", expected: "compactThread" },
  ])("hands $method of a Claude thread to $expected instead of the server", ({
    method,
    expected,
  }) => {
    const { router, calls } = setup(["th-claude"]);
    const line = encode({ id: 6, method, params: { threadId: "th-claude" } });

    expect(router.fromApp(line)).toBeNull();
    expect(calls.map(([name]) => name)).toEqual([expected]);
  });

  test("makes a fork of a Claude thread, such as a side chat, a Claude thread on the source's model", async () => {
    const { router, calls } = setup(["th-claude"]);
    const line = encode({
      id: 9,
      method: "thread/fork",
      params: { threadId: "th-claude", ephemeral: true },
    });

    expect(router.fromApp(line)).toBe(line);
    const out = parse(await router.fromServer(threadResponse(9, "th-side")));

    expect(calls).toEqual([
      [
        "adoptFork",
        "th-side",
        { model: CLAUDE, cwd: "/fixture/work" },
        "th-claude",
      ],
    ]);
    expect(out.result.model).toBe(CLAUDE);
    expect(out.result.thread.model).toBe(CLAUDE);
  });

  test("holds the fork's response until where its source stood is fixed", async () => {
    const { router, pinFork } = setup(["th-claude"], {}, "warn", true);
    router.fromApp(
      encode({
        id: 9,
        method: "thread/fork",
        params: { threadId: "th-claude" },
      }),
    );
    let answered = false;
    const response = Promise.resolve(
      router.fromServer(threadResponse(9, "th-side")),
    ).then((line) => {
      answered = true;
      return line;
    });

    await Bun.sleep(0);
    const beforePinned = answered;
    pinFork();

    expect(beforePinned).toBe(false);
    expect(parse(await response).result.model).toBe(CLAUDE);
  });

  test("runs the turns of a fork in the source's directory on Claude", async () => {
    const { router, calls } = setup(["th-claude"]);
    const fork = encode({
      id: 9,
      method: "thread/fork",
      params: { threadId: "th-claude", cwd: "/fixture/work/" },
    });
    const turn = encode({
      id: 10,
      method: "turn/start",
      params: { threadId: "th-side", input: [] },
    });

    expect(router.fromApp(fork)).toBe(fork);
    await router.fromServer(threadResponse(9, "th-side"));

    expect(router.fromApp(turn)).toBeNull();
    expect(calls.map(([name]) => name)).toEqual(["adoptFork", "startTurn"]);
  });

  test("refuses a fork of a Claude thread into another directory before the server makes it", () => {
    const { router, calls, events } = setup(["th-claude"]);
    const line = encode({
      id: 9,
      method: "thread/fork",
      params: { threadId: "th-claude", cwd: "/elsewhere" },
    });

    expect(router.fromApp(line)).toBeNull();
    expect(calls.map(([name]) => name)).toEqual(["reject"]);
    expect(events).toContainEqual({
      event: "claude_request_refused",
      method: "thread/fork",
      reason: "directory_change",
    });
  });

  test.each([
    { field: "lastTurnId" },
    { field: "beforeTurnId" },
  ])("refuses a fork of a Claude thread from an earlier turn named by $field", ({
    field,
  }) => {
    const { router, calls, events } = setup(["th-claude"]);
    const line = encode({
      id: 9,
      method: "thread/fork",
      params: { threadId: "th-claude", [field]: "turn-1" },
    });

    expect(router.fromApp(line)).toBeNull();
    expect(calls.map(([name]) => name)).toEqual(["reject"]);
    expect(events).toContainEqual({
      event: "claude_request_refused",
      method: "thread/fork",
      reason: "unsupported_request",
    });
  });

  test("leaves the fork of a Codex thread as the same bytes", async () => {
    const { router, calls } = setup();
    const line = encode({
      id: 9,
      method: "thread/fork",
      params: { threadId: "th-codex" },
    });
    const response = threadResponse(9, "th-side");

    expect(router.fromApp(line)).toBe(line);
    expect(await router.fromServer(response)).toBe(response);
    expect(calls).toEqual([]);
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

  test("moves a resumed Claude thread to the Claude model it names and hides it from the server", async () => {
    const { router, calls } = setup(["th-claude"]);

    const forwarded = router.fromApp(
      encode({
        id: 4,
        method: "thread/resume",
        params: { threadId: "th-claude", model: OTHER_CLAUDE },
      }),
    );
    const out = parse(await router.fromServer(threadResponse(4, "th-claude")));

    expect(parse(forwarded).params).toEqual({ threadId: "th-claude" });
    expect(calls).toEqual([["changeModel", "th-claude", OTHER_CLAUDE]]);
    expect(out.result.model).toBe(OTHER_CLAUDE);
  });

  test("reports the Claude thread's effort in the resume response", async () => {
    const { router } = setup(["th-claude"]);
    router.fromApp(settingsUpdate({ effort: "max" }));

    router.fromApp(
      encode({
        id: 4,
        method: "thread/resume",
        params: { threadId: "th-claude" },
      }),
    );
    const out = parse(
      await router.fromServer(threadResponse(4, "th-claude", "low")),
    );

    expect(out.result.reasoningEffort).toBe("max");
    expect(out.result.thread.reasoningEffort).toBe("max");
  });

  test("reports a new Claude thread at the model's default effort", async () => {
    const { router } = setup();

    router.fromApp(
      encode({
        id: 3,
        method: "thread/start",
        params: { cwd: "/fixture/work", model: CLAUDE },
      }),
    );
    const out = parse(
      await router.fromServer(threadResponse(3, "th-new", "xhigh")),
    );

    expect(out.result.reasoningEffort).toBe("high");
    expect(out.result.thread.reasoningEffort).toBe("high");
  });

  test("leaves the resume response of a Codex thread as the same bytes", async () => {
    const { router } = setup(["th-claude"]);
    router.fromApp(
      encode({
        id: 4,
        method: "thread/resume",
        params: { threadId: "th-codex" },
      }),
    );
    const response = threadResponse(4, "th-codex", "ultra");

    expect(await router.fromServer(response)).toEqual(response);
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

describe("Claude subagent threads", () => {
  test("lists the agents a Claude thread started under it with the server's own", async () => {
    const { router, subagents } = setup(["th-claude"]);
    startAgent(subagents, "th-claude", "toolu-1");

    const routed = router.fromApp(
      encode({
        id: 30,
        method: "thread/list",
        params: {
          ancestorThreadId: "th-claude",
          sourceKinds: ["subAgentThreadSpawn"],
        },
      }),
    );
    const out = parse(
      await router.fromServer(
        encode({ id: 30, result: { data: [], nextCursor: null } }),
      ),
    );

    expect(routed).not.toBeNull();
    const [child] = subagents.childrenOf("th-claude");
    expect(out.result.data).toEqual([
      expect.objectContaining({
        id: child?.id,
        parentThreadId: "th-claude",
        model: CLAUDE,
        cwd: "/fixture/work",
        threadSource: "subagent",
        agentNickname: "read the README",
        canAcceptDirectInput: false,
        status: { type: "active", activeFlags: [] },
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: "th-claude",
              depth: 1,
              agent_path: "/root/explore_1",
              agent_nickname: "read the README",
              agent_role: "Explore",
            },
          },
        },
      }),
    ]);
  });

  test.each([
    { name: "kinds other than subagents", params: { sourceKinds: ["vscode"] } },
    { name: "no parent", params: {} },
  ])("leaves a thread list of $name to the server", async ({ params }) => {
    const { router, subagents } = setup(["th-claude"]);
    startAgent(subagents, "th-claude", "toolu-1");
    const response = encode({ id: 31, result: { data: [], nextCursor: null } });

    router.fromApp(
      encode({
        id: 31,
        method: "thread/list",
        params: {
          ...("sourceKinds" in params ? { ancestorThreadId: "th-claude" } : {}),
          ...params,
        },
      }),
    );

    expect(await router.fromServer(response)).toEqual(response);
  });

  test("answers thread/read of an agent's thread from its parent's", async () => {
    const { router, subagents, sent, serverCalls } = setup(["th-claude"]);
    startAgent(subagents, "th-claude", "toolu-1");
    const [child] = subagents.childrenOf("th-claude");

    const routed = router.fromApp(
      encode({
        id: 32,
        method: "thread/read",
        params: { threadId: child?.id, includeTurns: true },
      }),
    );
    await until(() => responseTo(sent, 32) !== null);

    expect(routed).toBeNull();
    expect(serverCalls).toEqual([
      ["thread/read", { threadId: "th-claude", includeTurns: false }],
    ]);
    expect(responseTo(sent, 32).result.thread).toMatchObject({
      id: child?.id,
      parentThreadId: "th-claude",
      model: CLAUDE,
      path: "/fixture/rollout.jsonl",
      turns: [{ status: "inProgress", items: [{ type: "userMessage" }] }],
    });
  });

  test("resumes an agent's thread through its parent with none of the app's settings when the parent was not opened", async () => {
    const { router, subagents, sent, serverCalls } = setup(["th-claude"]);
    startAgent(subagents, "th-claude", "toolu-1");
    const [child] = subagents.childrenOf("th-claude");

    router.fromApp(
      encode({
        id: 33,
        method: "thread/resume",
        params: {
          threadId: child?.id,
          path: "/fixture/rollout.jsonl",
          excludeTurns: true,
          approvalPolicy: "on-request",
        },
      }),
    );
    await until(() => responseTo(sent, 33) !== null);

    expect(serverCalls).toEqual([
      ["thread/resume", { threadId: "th-claude", excludeTurns: true }],
    ]);
    expect(responseTo(sent, 33).result).toMatchObject({
      model: CLAUDE,
      cwd: "/fixture/work",
      approvalPolicy: "on-request",
      thread: { id: child?.id, parentThreadId: "th-claude" },
      turnsBackwardsCursor: `at:${child?.id}-turn-1`,
    });
  });

  test("answers an agent's resume and list from the answer that opened its parent", async () => {
    const { router, subagents, sent, serverCalls } = setup(["th-claude"]);
    router.fromApp(
      encode({
        id: 40,
        method: "thread/resume",
        params: { threadId: "th-claude", excludeTurns: true },
      }),
    );
    await router.fromServer(
      encode({
        id: 40,
        result: { ...PARENT_RESUMED, thread: parentThread("th-claude") },
      }),
    );
    startAgent(subagents, "th-claude", "toolu-1");
    const [child] = subagents.childrenOf("th-claude");

    router.fromApp(
      encode({
        id: 41,
        method: "thread/resume",
        params: { threadId: child?.id, excludeTurns: true },
      }),
    );
    router.fromApp(
      encode({
        id: 42,
        method: "thread/list",
        params: { ancestorThreadId: "th-claude" },
      }),
    );
    const listed = parse(
      router.fromServer(encode({ id: 42, result: { data: [] } })) as Buffer,
    );
    await until(() => responseTo(sent, 41) !== null);

    expect(serverCalls).toEqual([]);
    expect(responseTo(sent, 41).result).toMatchObject({
      approvalPolicy: "on-request",
      thread: { id: child?.id, path: "/fixture/rollout.jsonl" },
    });
    expect(listed.result.data).toMatchObject([
      { id: child?.id, path: "/fixture/rollout.jsonl", model: CLAUDE },
    ]);
  });

  test.each([
    { name: "a later page", params: { cursor: "page-2" } },
    { name: "archived threads", params: { archived: true } },
  ])("adds no agent to $name", async ({ params }) => {
    const { router, subagents } = setup(["th-claude"]);
    startAgent(subagents, "th-claude", "toolu-1");
    const response = encode({ id: 43, result: { data: [] } });

    router.fromApp(
      encode({
        id: 43,
        method: "thread/list",
        params: { ancestorThreadId: "th-claude", ...params },
      }),
    );

    expect(parse(router.fromServer(response) as Buffer).result.data).toEqual(
      [],
    );
  });

  test("lists the agents an agent started under that agent's thread", async () => {
    const { router, subagents } = setup(["th-claude"]);
    startAgent(subagents, "th-claude", "toolu-1");
    const [outer] = subagents.childrenOf("th-claude");
    subagents.message("th-claude", {
      type: "assistant",
      message: {
        id: "msg-1",
        content: [
          { type: "tool_use", id: "toolu-2", name: "Agent", input: {} },
        ],
        stop_reason: null,
      },
      parent_tool_use_id: "toolu-1",
    } as unknown as SDKMessage);
    subagents.start({
      threadId: "th-claude",
      turnId: null,
      toolUseId: "toolu-2",
      taskId: "task-2",
      description: "dig deeper",
      agentType: null,
      cwd: "/fixture/work",
      prompt: null,
      depth: 2,
    });

    router.fromApp(
      encode({
        id: 44,
        method: "thread/list",
        params: { ancestorThreadId: outer?.id },
      }),
    );
    const listed = parse(
      router.fromServer(encode({ id: 44, result: { data: [] } })) as Buffer,
    );

    expect(listed.result.data).toMatchObject([
      {
        parentThreadId: outer?.id,
        agentNickname: "dig deeper",
        model: CLAUDE,
        source: { subAgent: { thread_spawn: { depth: 2 } } },
      },
    ]);
  });

  test("answers an agent's turn pages and goal itself", async () => {
    const { router, subagents, sent, serverCalls } = setup(["th-claude"]);
    startAgent(subagents, "th-claude", "toolu-1");
    const [child] = subagents.childrenOf("th-claude");

    router.fromApp(
      encode({
        id: 34,
        method: "thread/turns/list",
        params: { threadId: child?.id, limit: 5 },
      }),
    );
    router.fromApp(
      encode({
        id: 35,
        method: "thread/goal/get",
        params: { threadId: child?.id },
      }),
    );
    await until(() => responseTo(sent, 34) !== null);

    expect(responseTo(sent, 34).result.data).toMatchObject([
      {
        id: `${child?.id}-turn-1`,
        status: "inProgress",
        itemsView: "notLoaded",
      },
    ]);
    expect(responseTo(sent, 35)).toEqual({ id: 35, result: { goal: null } });
    expect(serverCalls).toEqual([]);
  });

  test("completes an agent's turn in its timeline only once the agent completes", async () => {
    const { router, subagents, sent } = setup(["th-claude"]);
    startAgent(subagents, "th-claude", "toolu-1");
    const [child] = subagents.childrenOf("th-claude");
    const timeline = async (id: number) => {
      router.fromApp(
        encode({
          id,
          method: "thread/timeline/list",
          params: { threadId: child?.id },
        }),
      );
      await until(() => responseTo(sent, id) !== null);
      return responseTo(sent, id).result.data;
    };

    const running = await timeline(37);
    subagents.complete("th-claude", "task-1", { status: "completed" });
    const completed = await timeline(38);

    expect(running).toMatchObject([
      { type: "turnStarted", position: 0, turnId: `${child?.id}-turn-1` },
      { type: "item", position: 1, item: { type: "userMessage" } },
    ]);
    expect(running).toHaveLength(2);
    expect(completed).toMatchObject([
      ...running,
      {
        type: "turnCompleted",
        position: 2,
        turnId: `${child?.id}-turn-1`,
        status: "completed",
        completedAt: expect.any(Number),
      },
    ]);
  });

  test("adds a nested agent's completion to its parent agent's newest turn, so a timeline cursor the app holds still pages back over every entry once", async () => {
    const { router, subagents, sent } = setup(["th-claude"]);
    const start = (toolUseId: string, taskId: string, depth: number) =>
      subagents.start({
        threadId: "th-claude",
        turnId: "turn-1",
        toolUseId,
        taskId,
        description: "read the README",
        agentType: "Explore",
        cwd: "/fixture/work",
        prompt: "read the README",
        depth,
      });
    start("toolu-1", "task-outer", 1);
    const [outer] = subagents.childrenOf("th-claude");
    subagents.message("th-claude", {
      type: "assistant",
      message: {
        id: "msg-outer",
        content: [
          {
            type: "tool_use",
            id: "toolu-inner",
            name: "Agent",
            input: { prompt: "dig" },
          },
        ],
        stop_reason: null,
      },
      parent_tool_use_id: "toolu-1",
    } as unknown as SDKMessage);
    start("toolu-inner", "task-inner", 2);
    subagents.complete("th-claude", "task-outer", { status: "completed" });
    start("toolu-2", "task-outer", 1);
    let id = 40;
    const timeline = async (params: object) => {
      id += 1;
      router.fromApp(
        encode({
          id,
          method: "thread/timeline/list",
          params: { threadId: outer?.id, ...params },
        }),
      );
      await until(() => responseTo(sent, id) !== null);
      return responseTo(sent, id).result;
    };

    const whole = (await timeline({})).data;
    const newest = await timeline({ limit: 3 });
    subagents.complete("th-claude", "task-inner", { status: "completed" });
    const older = await timeline({ cursor: newest.nextCursor });
    const after = (await timeline({})).data;

    expect(newest.nextCursor).toBe(`before:${whole.length - 3}`);
    expect([...older.data, ...newest.data]).toEqual(whole);
    const completion = {
      type: "item",
      turnId: `${outer?.id}-turn-2`,
      item: { type: "subAgentActivity", kind: "completed" },
    };
    expect(after).toMatchObject([...whole, completion]);
    expect(after).toHaveLength(whole.length + 1);
    expect(
      (sent as { method?: string; params?: { item?: { kind?: string } } }[])
        .filter(
          (m) =>
            m.method === "item/completed" &&
            m.params?.item?.kind === "completed",
        )
        .map((m) => m.params),
    ).toMatchObject([
      { threadId: "th-claude" },
      { threadId: outer?.id, turnId: `${outer?.id}-turn-2` },
    ]);
  });

  test("refuses a turn sent to an agent's thread", async () => {
    const { router, subagents, sent, calls } = setup(["th-claude"]);
    startAgent(subagents, "th-claude", "toolu-1");
    const [child] = subagents.childrenOf("th-claude");

    const routed = router.fromApp(
      encode({
        id: 36,
        method: "turn/start",
        params: { threadId: child?.id, input: [] },
      }),
    );

    expect(routed).toBeNull();
    expect(responseTo(sent, 36).error.message).toContain("turn/start");
    expect(calls).toEqual([]);
  });
});

describe("app responses", () => {
  test.each([
    { name: "the bridge's own request", id: BRIDGE_REQUEST, expected: null },
    { name: "the server's request", id: 1, expected: true },
  ])("hands an answer to $name to the turns first and forwards it unchanged only for the server", ({
    id,
    expected,
  }) => {
    const { router, calls } = setup(["th-claude"]);
    const answer = { id, result: { decision: "accept" } };
    const line = encode(answer);

    const routed = router.fromApp(line);

    expect(routed?.equals(line) ?? null).toBe(expected);
    expect(calls).toEqual([["answerRequest", answer]]);
  });
});

describe("thread/settings/update", () => {
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
    expect(calls).toEqual([["selectMode", "th-claude", "default"]]);
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
    expect(calls.filter(([name]) => name !== "selectMode")).toEqual([
      ["changeModel", "th-claude", OTHER_CLAUDE],
    ]);
  });

  test.each([
    {
      name: "a Codex model in the collaboration mode alone",
      change: {
        collaborationMode: { mode: "default", settings: { model: "gpt-x" } },
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

  test.each([
    { name: "a model", change: { model: "gpt-fixture" } },
    { name: "an effort", change: { effort: "high" } },
  ])("leaves $name picked on a Codex thread to the server as the same bytes", ({
    change,
  }) => {
    const { router } = setup();
    const line = settingsUpdate(change);

    expect(router.fromApp(line)).toEqual(line);
  });

  test("keeps a Claude thread's effort from the server", () => {
    const { router, calls } = setup(["th-claude"]);

    const forwarded = router.fromApp(
      settingsUpdate({ effort: "max", approvalPolicy: "never" }),
    );

    expect(parse(forwarded).params).toEqual({
      threadId: "th-claude",
      approvalPolicy: "never",
    });
    expect(calls).toEqual([["selectEffort", "th-claude", "max"]]);
  });

  test("reads a Claude thread's effort from the collaboration mode when the update has none", () => {
    const { router, calls } = setup(["th-claude"]);

    router.fromApp(
      settingsUpdate({
        collaborationMode: {
          mode: "default",
          settings: { model: CLAUDE, reasoning_effort: "xhigh" },
        },
      }),
    );

    expect(calls).toContainEqual(["selectEffort", "th-claude", "xhigh"]);
  });

  test("reports the Claude model on resume even when the history mentions the settings notice", async () => {
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
    const out = parse(await router.fromServer(encode(response)));

    expect(out.result.model).toBe(CLAUDE);
  });

  test("forwards the same directory spelled with a trailing slash", () => {
    const { router, calls } = setup(["th-claude"]);
    const line = settingsUpdate({ cwd: "/fixture/work/" });

    expect(router.fromApp(line)).toEqual(line);
    expect(calls).toEqual([]);
  });

  test("keeps plan mode picked for a Claude thread from the server", async () => {
    const { router, calls } = setup(["th-claude"]);

    const forwarded = router.fromApp(
      settingsUpdate({
        collaborationMode: { mode: "plan", settings: { model: CLAUDE } },
      }),
    );
    const out = parse(await router.fromServer(settingsNotice("default")));

    expect(parse(forwarded).params).toEqual({ threadId: "th-claude" });
    expect(calls).toEqual([["selectMode", "th-claude", "plan"]]);
    expect(out.params.threadSettings.collaborationMode.mode).toBe("plan");
  });

  test.each([
    {
      name: "an effort picked",
      change: { effort: "max" },
      model: CLAUDE,
      expected: "max",
    },
    { name: "no effort picked", change: {}, model: CLAUDE, expected: "high" },
    {
      name: "a model without effort",
      change: { model: "claude-haiku-4-5", effort: "max" },
      model: "claude-haiku-4-5",
      expected: "medium",
    },
  ])("reports the model and the level a Claude thread with $name runs at in the settings notice", async ({
    change,
    model,
    expected,
  }) => {
    const { router } = setup(["th-claude"]);
    router.fromApp(settingsUpdate(change));

    const out = parse(await router.fromServer(settingsNotice("default")));

    const settings = out.params.threadSettings;
    expect({
      model: settings.model,
      effort: settings.effort,
      collaborationModel: settings.collaborationMode.settings.model,
      collaborationEffort: settings.collaborationMode.settings.reasoning_effort,
    }).toEqual({
      model,
      effort: expected,
      collaborationModel: model,
      collaborationEffort: expected,
    });
  });

  test("leaves the settings notice of a Codex thread as the same bytes", async () => {
    const { router } = setup(["th-claude"]);
    const notice = encode({
      method: "thread/settings/updated",
      params: {
        threadId: "th-codex",
        threadSettings: { model: "gpt-fixture", effort: "ultra" },
      },
    });

    expect(await router.fromServer(notice)).toEqual(notice);
  });
});

describe("Claude thread history", () => {
  test("resumes a Claude thread with an initial page and cursors the app can page back through without the server", async () => {
    const { router, reads, sent } = setup(["th-claude"], {
      "th-claude": conversation(),
    });

    router.fromApp(
      encode({
        id: 4,
        method: "thread/resume",
        params: {
          threadId: "th-claude",
          excludeTurns: true,
          initialTurnsPage: {
            limit: 1,
            itemsView: "full",
            sortDirection: "desc",
          },
        },
      }),
    );
    const out = parse(await router.fromServer(threadResponse(4, "th-claude")));
    const askTurns = async (id: number, cursor: string | null) => {
      const forwarded = router.fromApp(
        encode({
          id,
          method: "thread/turns/list",
          params: {
            threadId: "th-claude",
            cursor,
            limit: 1,
            itemsView: "notLoaded",
          },
        }),
      );
      await Bun.sleep(0);
      return { forwarded, page: responseTo(sent, id).result };
    };
    const opening = out.result.turnsBackwardsCursor;
    const newest = await askTurns(10, opening);
    const older = await askTurns(11, newest.page.nextCursor);
    router.fromApp(
      encode({
        id: 20,
        method: "thread/turns/list",
        params: {
          threadId: "th-claude",
          cursor: out.result.initialTurnsPage.nextCursor,
        },
      }),
    );
    await Bun.sleep(0);

    expect(reads[0]).toBe("session-th-claude");
    expect(out.result.model).toBe(CLAUDE);
    expect(out.result.thread).not.toHaveProperty("turns");
    expect(typeof opening).toBe("string");
    expect(
      out.result.initialTurnsPage.data.map((turn: { id: string }) => turn.id),
    ).toEqual(["harnexus-history-u2"]);
    expect([newest.page.data, older.page.data]).toEqual([
      [
        expect.objectContaining({
          id: "harnexus-history-u2",
          itemsView: "notLoaded",
          items: [],
        }),
      ],
      [
        expect.objectContaining({
          id: "harnexus-history-u1",
          itemsView: "notLoaded",
          items: [],
        }),
      ],
    ]);
    expect(older.page.nextCursor).toBeNull();
    expect([newest.forwarded, older.forwarded]).toEqual([null, null]);
    expect(
      responseTo(sent, 20).result.data.map((turn: { id: string }) => turn.id),
    ).toEqual(["harnexus-history-u1"]);
  });

  test("resumes a Claude thread with an item cursor that starts from the thread's newest item", async () => {
    const { router, sent } = setup(["th-claude"], {
      "th-claude": conversation(),
    });

    router.fromApp(
      encode({
        id: 4,
        method: "thread/resume",
        params: { threadId: "th-claude", excludeTurns: true },
      }),
    );
    const out = parse(await router.fromServer(threadResponse(4, "th-claude")));
    router.fromApp(
      encode({
        id: 5,
        method: "thread/items/list",
        params: {
          threadId: "th-claude",
          cursor: out.result.itemsBackwardsCursor,
          sortDirection: "desc",
        },
      }),
    );
    await Bun.sleep(0);

    expect(responseTo(sent, 5).result.data).toMatchObject([
      { turnId: "harnexus-history-u2", item: { text: "welcome" } },
      { turnId: "harnexus-history-u2", item: { type: "userMessage" } },
      { turnId: "harnexus-history-u1", item: { text: "one file" } },
      { turnId: "harnexus-history-u1", item: { type: "commandExecution" } },
      { turnId: "harnexus-history-u1", item: { type: "reasoning" } },
      { turnId: "harnexus-history-u1", item: { type: "userMessage" } },
    ]);
  });

  test("fills the thread's turns when the resume asks for the whole history", async () => {
    const { router } = setup(["th-claude"], { "th-claude": conversation() });

    router.fromApp(
      encode({
        id: 4,
        method: "thread/resume",
        params: { threadId: "th-claude" },
      }),
    );
    const out = parse(await router.fromServer(threadResponse(4, "th-claude")));

    expect(
      out.result.thread.turns.map((turn: { id: string; itemsView: string }) => [
        turn.id,
        turn.itemsView,
      ]),
    ).toEqual([
      ["harnexus-history-u1", "full"],
      ["harnexus-history-u2", "full"],
    ]);
    expect(out.result).not.toHaveProperty("initialTurnsPage");
  });

  test("keeps the pick for the next resume when the server fails one", async () => {
    const { router, picked } = setup(["th-claude"], {
      "th-claude": conversation(),
    });
    picked.add("th-claude");
    const resume = (id: number) =>
      router.fromApp(
        encode({
          id,
          method: "thread/resume",
          params: { threadId: "th-claude", excludeTurns: true },
        }),
      );

    resume(4);
    await router.fromServer(
      encode({ id: 4, error: { code: -32600, message: "not loaded" } }),
    );
    resume(5);
    const out = parse(await router.fromServer(threadResponse(5, "th-claude")));

    expect(out.result.thread.turns).toHaveLength(2);
  });

  test("fills the turns of the first resume after a conversation was picked, though the app excludes them", async () => {
    const { router, picked } = setup(["th-claude"], {
      "th-claude": conversation(),
    });
    picked.add("th-claude");
    const resume = (id: number) => {
      router.fromApp(
        encode({
          id,
          method: "thread/resume",
          params: { threadId: "th-claude", excludeTurns: true },
        }),
      );
      return router.fromServer(threadResponse(id, "th-claude"));
    };

    const first = parse(await resume(4));
    const second = parse(await resume(5));

    expect(first.result.thread.turns).toHaveLength(2);
    expect(typeof first.result.turnsBackwardsCursor).toBe("string");
    expect(second.result.thread).not.toHaveProperty("turns");
  });

  test("logs the shape of the resume request and how many turns answered it, without the conversation", async () => {
    const { router, events } = setup(["th-claude"], {
      "th-claude": conversation(),
    });

    router.fromApp(
      encode({
        id: 4,
        method: "thread/resume",
        params: { threadId: "th-claude", excludeTurns: true },
      }),
    );
    await router.fromServer(threadResponse(4, "th-claude"));
    router.fromApp(
      encode({
        id: 5,
        method: "thread/read",
        params: { threadId: "th-claude", includeTurns: true },
      }),
    );
    await router.fromServer(threadResponse(5, "th-claude"));

    expect(events).toEqual([
      {
        event: "claude_history_served",
        method: "thread/resume",
        thread: "th-claud",
        excludeTurns: true,
        initialPage: false,
        picked: false,
        turns: 2,
      },
      {
        event: "claude_history_served",
        method: "thread/read",
        thread: "th-claud",
        excludeTurns: false,
        initialPage: false,
        picked: false,
        turns: 2,
      },
    ]);
  });

  test("fills the turns of thread/read for a Claude thread", async () => {
    const { router } = setup(["th-claude"], { "th-claude": conversation() });

    router.fromApp(
      encode({
        id: 6,
        method: "thread/read",
        params: { threadId: "th-claude", includeTurns: true },
      }),
    );
    const out = parse(await router.fromServer(threadResponse(6, "th-claude")));

    expect(out.result.thread.turns).toHaveLength(2);
  });

  test("passes the resume response with the Claude model alone when the record cannot be read", async () => {
    const { router, events } = setup(["th-claude"], {
      "th-claude": "unreadable",
    });

    router.fromApp(
      encode({
        id: 4,
        method: "thread/resume",
        params: {
          threadId: "th-claude",
          excludeTurns: true,
          initialTurnsPage: {},
        },
      }),
    );
    const out = parse(await router.fromServer(threadResponse(4, "th-claude")));

    expect(out.result.model).toBe(CLAUDE);
    expect(out.result).not.toHaveProperty("turnsBackwardsCursor");
    expect(events).toEqual([
      { event: "claude_history_unreadable", error: "ClaudeRecordUnreadable" },
    ]);
  });

  test("answers thread/items/list with the items of the asked turn", async () => {
    const { router, sent } = setup(["th-claude"], {
      "th-claude": conversation(),
    });

    router.fromApp(
      encode({
        id: 8,
        method: "thread/items/list",
        params: {
          threadId: "th-claude",
          turnId: "harnexus-history-u2",
          sortDirection: "asc",
        },
      }),
    );
    await Bun.sleep(0);

    expect(sent).toMatchObject([
      {
        id: 8,
        result: {
          data: [
            { turnId: "harnexus-history-u2", item: { type: "userMessage" } },
            { turnId: "harnexus-history-u2", item: { type: "agentMessage" } },
          ],
        },
      },
    ]);
  });

  test("answers thread/timeline/list from the newest entry back", async () => {
    const { router, sent } = setup(["th-claude"], {
      "th-claude": conversation(),
    });

    router.fromApp(
      encode({
        id: 9,
        method: "thread/timeline/list",
        params: { threadId: "th-claude", limit: 1 },
      }),
    );
    await Bun.sleep(0);

    expect(sent).toMatchObject([
      {
        id: 9,
        result: {
          data: [{ type: "turnCompleted", turnId: "harnexus-history-u2" }],
          activeRealtimeSessionAtPageStart: null,
        },
      },
    ]);
  });

  test("answers an empty history for a Claude thread that has no session yet", async () => {
    const { router, sent, reads } = setup(["th-claude"]);

    router.fromApp(
      encode({
        id: 7,
        method: "thread/turns/list",
        params: { threadId: "th-claude" },
      }),
    );
    await Bun.sleep(0);

    expect(reads).toEqual([]);
    expect(sent).toEqual([
      { id: 7, result: { data: [], nextCursor: null, backwardsCursor: null } },
    ]);
  });

  test.each([
    {
      name: "an unreadable record",
      record: "unreadable" as const,
      expected: -32603,
    },
    { name: "an unknown cursor", record: conversation(), expected: -32602 },
  ])("answers a history page with error $expected for $name", async ({
    record,
    expected,
  }) => {
    const { router, sent } = setup(["th-claude"], { "th-claude": record });

    router.fromApp(
      encode({
        id: 7,
        method: "thread/turns/list",
        params: { threadId: "th-claude", cursor: "server-cursor" },
      }),
    );
    await Bun.sleep(0);

    expect(sent).toMatchObject([{ id: 7, error: { code: expected } }]);
  });

  test("reads the record once for history pages asked for together and again for a later page", async () => {
    const records = { "th-claude": conversation() };
    const { router, sent, reads } = setup(["th-claude"], records);
    const askTurns = (id: number) =>
      router.fromApp(
        encode({
          id,
          method: "thread/turns/list",
          params: { threadId: "th-claude" },
        }),
      );

    askTurns(7);
    askTurns(8);
    await Bun.sleep(0);
    records["th-claude"] = [
      ...conversation(),
      prompt("u3", "one more"),
      reply("a5", "m4", text("sure"), "end_turn"),
    ];
    askTurns(9);
    await Bun.sleep(0);

    expect(reads).toEqual(["session-th-claude", "session-th-claude"]);
    expect([7, 8].map((id) => responseTo(sent, id).result.data.length)).toEqual(
      [2, 2],
    );
    expect(responseTo(sent, 9).result.data[0].id).toBe("harnexus-history-u3");
  });

  test.each([
    { name: "thread/turns/list", params: { threadId: "codex" } },
    { name: "thread/items/list", params: { threadId: "codex", turnId: "t" } },
    { name: "thread/timeline/list", params: { threadId: "codex" } },
    { name: "thread/read", params: { threadId: "codex", includeTurns: true } },
  ])("leaves $name of a Codex thread to the server", async ({
    name,
    params,
  }) => {
    const { router, sent, reads } = setup(["th-claude"], {
      "th-claude": conversation(),
    });
    const request = encode({ id: 7, method: name, params });
    const response = threadResponse(7, "codex");

    const routed = router.fromApp(request);
    const answered = await router.fromServer(response);

    expect(routed).toEqual(request);
    expect(answered).toEqual(response);
    expect({ sent, reads }).toEqual({ sent: [], reads: [] });
  });
});

const CLAUDE = "claude-sonnet-5";
const VERIFIED_AGENT = "Codex Desktop/0.158.0-alpha.2.1 (Mac OS 26.5.1; arm64)";
const UNVERIFIED_AGENT = "Codex Desktop/0.159.0 (Mac OS 26.5.1; arm64)";

const initializeAnswer = (userAgent: string) =>
  encode({ id: 1, result: { userAgent, codexHome: "/fixture/.codex" } });
const BRIDGE_REQUEST = "harnexus-1";

const settingsNotice = (mode: string) =>
  encode({
    method: "thread/settings/updated",
    params: {
      threadId: "th-claude",
      threadSettings: {
        model: "gpt-fixture",
        effort: "low",
        collaborationMode: {
          mode,
          settings: { model: "gpt-fixture", reasoning_effort: "low" },
        },
      },
    },
  });
const OTHER_CLAUDE = "claude-opus-5-5";

const settingsUpdate = (change: object) =>
  encode({
    id: 8,
    method: "thread/settings/update",
    params: { threadId: "th-claude", ...change },
  });

// A thread named in records has a session whose record holds those messages; "unreadable" makes reading it fail.
const setup = (
  claudeThreads: string[] = [],
  records: Record<string, SessionMessage[] | "unreadable"> = {},
  unverifiedCodex: "warn" | "pause" = "warn",
  holdForks = false,
  vertex = false,
) => {
  const calls: unknown[][] = [];
  const events: RouteEvent[] = [];
  let pinFork = () => {};
  const forkPinned = new Promise<void>((resolve) => {
    pinFork = resolve;
  });
  if (!holdForks) pinFork();
  const sent: object[] = [];
  const reads: string[] = [];
  const picked = new Set<string>();
  const threads = new Map(
    claudeThreads.map((id) => [id, { model: CLAUDE, cwd: "/fixture/work" }]),
  );
  const subagents = createSubagents({
    send: (message) => sent.push(message),
    now: () => SUBAGENT_STARTED_MS,
  });
  const history = createHistoryRequests({
    subagentHistory: subagents.historyOf,
    threads: {
      threadOf: (threadId) => threads.get(threadId),
      sessionIdOf: (threadId) =>
        threadId in records ? `session-${threadId}` : null,
      takePicked: (threadId) => picked.delete(threadId),
    },
    readSession: (sessionId) => {
      reads.push(sessionId);
      return readClaudeSession(sessionId, {
        read: async () => {
          const record = records[sessionId.replace("session-", "")];
          if (record !== undefined && record !== "unreadable") return record;
          // biome-ignore lint/plugin/no-throw-try-catch: getSessionMessages rejects when the record cannot be read.
          throw new Error("unreadable");
        },
      });
    },
    send: (message) => sent.push(message),
    log: (event) => events.push(event),
  });
  const modes = new Map<string, Mode>();
  const efforts = new Map<string, EffortLevel>();
  const catalog = createModelCatalog();
  const rule = effortRule({}, catalog.effortsOf);
  const effortOf = (threadId: string) => {
    const model = threads.get(threadId)?.model;
    return model === undefined
      ? null
      : rule(model, efforts.get(threadId) ?? null);
  };
  const serverCalls: [string, unknown][] = [];
  const subagentRequests = createSubagentRequests({
    subagents,
    threads: { threadOf: (threadId) => threads.get(threadId), effortOf },
    call: async (method, params) => {
      serverCalls.push([method, params]);
      const threadId = String((params as { threadId: unknown }).threadId);
      return Result.ok(
        method === "thread/resume"
          ? { ...PARENT_RESUMED, thread: parentThread(threadId) }
          : { thread: parentThread(threadId) },
      );
    },
    history: history.load,
    send: (message) => sent.push(message),
  });
  const router = createRouter(
    {
      isClaudeThread: (threadId) =>
        typeof threadId === "string" && threads.has(threadId),
      threadOf: (threadId) => threads.get(threadId),
      adopt: (threadId, thread) => {
        calls.push(["adopt", threadId, thread]);
        threads.set(threadId, thread);
      },
      adoptFork: (threadId, thread, sourceId) => {
        calls.push(["adoptFork", threadId, thread, sourceId]);
        threads.set(threadId, thread);
        return forkPinned;
      },
      changeModel: (threadId, model) => {
        calls.push(["changeModel", threadId, model]);
        const thread = threads.get(threadId);
        if (thread !== undefined) threads.set(threadId, { ...thread, model });
      },
      startTurn: (request: AppRequest, cwd) =>
        calls.push(["startTurn", request, cwd]),
      compactThread: (request) => calls.push(["compactThread", request]),
      steerTurn: (request) => calls.push(["steerTurn", request]),
      interruptTurn: (request) => calls.push(["interruptTurn", request]),
      reject: (request, message) => calls.push(["reject", request, message]),
      answerRequest: (response) => {
        calls.push(["answerRequest", response]);
        return response.id === BRIDGE_REQUEST;
      },
      selectMode: (threadId, mode) => {
        calls.push(["selectMode", threadId, mode]);
        modes.set(threadId, mode);
      },
      modeOf: (threadId) => modes.get(threadId),
      selectEffort: (threadId, effort) => {
        calls.push(["selectEffort", threadId, effort]);
        if (isClaudeEffort(effort)) efforts.set(threadId, effort);
      },
      effortOf,
      effortRule: rule,
    },
    (event) => events.push(event),
    (source, threadId) => calls.push(["delegated", source, threadId]),
    history,
    () => ({ ...catalog.models(), vertex }),
    unverifiedCodex,
    subagentRequests,
  );
  return {
    router,
    calls,
    events,
    sent,
    reads,
    picked,
    catalog,
    pinFork,
    subagents,
    serverCalls,
  };
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

const threadResponse = (
  id: number,
  threadId: string,
  reasoningEffort?: string,
) =>
  encode({
    id,
    result: {
      thread: {
        id: threadId,
        model: "gpt-fixture",
        cwd: "/fixture/work",
        ...(reasoningEffort !== undefined && { reasoningEffort }),
      },
      model: "gpt-fixture",
      cwd: "/fixture/work",
      ...(reasoningEffort !== undefined && { reasoningEffort }),
    },
  });

const encode = (message: object) => Buffer.from(`${JSON.stringify(message)}\n`);

// The bridge answers history requests itself, so their responses are among what it sent to the app.
const responseTo = (sent: object[], id: number) =>
  JSON.parse(
    JSON.stringify(
      sent.find((message) => "id" in message && message.id === id) ?? null,
    ),
  );

const parse = (line: Buffer | null) => JSON.parse(line?.toString() ?? "null");

const FIXTURE_DIR = join(import.meta.dir, "../../test/fixtures/app-server");

const SUBAGENT_STARTED_MS = 1_700_000_000_000;

// The parent's thread as the server reports it; the server keeps its own Codex model for a Claude thread.
const parentThread = (threadId: string) => ({
  id: threadId,
  model: "gpt-fixture",
  cwd: "/fixture/work",
  path: "/fixture/rollout.jsonl",
  historyMode: "paginated",
  status: { type: "idle" },
  turns: [],
});

const PARENT_RESUMED = {
  model: "gpt-fixture",
  reasoningEffort: "low",
  cwd: "/fixture/work",
  approvalPolicy: "on-request",
};

const startAgent = (
  subagents: ReturnType<typeof setup>["subagents"],
  threadId: string,
  toolUseId: string,
) =>
  subagents.start({
    threadId,
    turnId: "turn-1",
    toolUseId,
    taskId: "task-1",
    description: "read the README",
    agentType: "Explore",
    cwd: "/fixture/work",
    prompt: "read the README",
    depth: 1,
  });

const until = async (condition: () => boolean) => {
  for (let waited = 0; !condition(); waited += 2) {
    if (waited > 2000) return expect.unreachable("condition never held");
    await Bun.sleep(2);
  }
};
