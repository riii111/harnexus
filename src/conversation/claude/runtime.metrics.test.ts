import { describe, expect, test } from "bun:test";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { effortRule } from "../../infra/claude/models.ts";
import { fakeClaude } from "../../infra/claude/testing/fake-claude.ts";
import { writeFileAtomic } from "../../runtime/fs.boundary.ts";
import type { createTurnController } from "../controller.ts";
import {
  answer,
  BUILT_IN_EFFORTS,
  completedTurnStatuses,
  completeTurn,
  createGate,
  dir,
  diskFull,
  firstPrompt,
  harness,
  MODEL,
  OTHER_THREAD,
  readPrompts,
  reply,
  responseTo,
  type Sent,
  SUBSCRIPTION,
  sdk,
  success,
  THREAD,
  turnCompleted,
  turnStart,
  twoWorkers,
  until,
  useTempDir,
  withEffort,
} from "../testing/harness.ts";
import { steer } from "./testing/runtime-fixtures.ts";

useTempDir();

describe("effort", () => {
  test.each<{
    name: string;
    request: () => ReturnType<typeof turnStart>;
    expected: EffortLevel;
  }>([
    {
      name: "the turn/start",
      request: () => withEffort(turnStart(10, "hello"), "high"),
      expected: "high",
    },
    {
      name: "the collaboration mode when the turn/start has none",
      request: () => {
        const request = turnStart(10, "hello");
        return {
          ...request,
          params: {
            ...request.params,
            collaborationMode: {
              mode: "default",
              settings: { model: MODEL, reasoning_effort: "xhigh" },
            },
          },
        };
      },
      expected: "xhigh",
    },
  ])("sets the effort $name names and logs the level", async ({
    request,
    expected,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, events } = await harness([claude]);

    turns.startTurn(request(), undefined);
    await until(() => claude.started());

    expect(await firstPrompt(claude.prompt())).toBe("hello");
    expect(claude.efforts()).toEqual([expected]);
    expect(events).toContainEqual({
      event: "claude_turn",
      step: "effort_applied",
      effort: expected,
    });
  });

  test("runs another thread's reply, which names no effort, at the thread's effort", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    turns.startTurn(withEffort(turnStart(10, "hello"), "max"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    claude.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 1);

    turns.startTurn(reply(11, THREAD, "th-lead"), undefined);
    await until(() => claude.efforts().length === 2);

    expect(claude.efforts()).toEqual(["max", "max"]);
  });

  test("leaves the running turn at its effort and sets a change at the next turn", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, threads, sent } = await harness([claude]);
    turns.startTurn(withEffort(turnStart(10, "hello"), "low"), undefined);
    await until(() => claude.efforts().length === 1);

    threads.selectEffort(THREAD, "max");
    claude.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 1);
    const whileRunning = [...claude.efforts()];
    await completeTurn(turns, sent, claude, 11);

    expect(whileRunning).toEqual(["low"]);
    expect(claude.efforts()).toEqual(["low", "max"]);
  });

  test("runs a queued turn at the effort it was accepted with", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, threads, sent } = await harness([claude]);
    turns.startTurn(withEffort(turnStart(10, "hello"), "low"), undefined);
    await until(() => claude.efforts().length === 1);

    turns.startTurn(withEffort(turnStart(11, "next"), "high"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    threads.selectEffort(THREAD, "max");
    claude.emit(sdk(success()));
    await until(() => claude.efforts().length === 2);

    expect(claude.efforts()).toEqual(["low", "high"]);
  });

  test("runs a turn with no level picked at the default the app shows for the thread", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, threads } = await harness([claude], {
      effortRule: effortRule({ effortLevel: "low" }, BUILT_IN_EFFORTS),
    });

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.efforts().length === 1);

    expect(claude.efforts()).toEqual(["low"]);
    expect(threads.effortOf(THREAD)).toBe("low");
  });

  test("sends the prompt to a model without effort without setting one", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns } = await harness([claude]);
    const request = withEffort(turnStart(10, "hello"), "high");

    turns.startTurn(
      { ...request, params: { ...request.params, model: HAIKU } },
      undefined,
    );
    await until(() => claude.started());

    expect(await firstPrompt(claude.prompt())).toBe("hello");
    expect(claude.efforts()).toEqual([]);
  });

  test("keeps the thread's effort when a turn/start names a level only Codex has", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, events, store } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10, undefined, "high");

    await completeTurn(turns, sent, claude, 11, undefined, "ultra");

    expect(claude.efforts()).toEqual(["high", "high"]);
    expect(events).toContainEqual({
      event: "claude_turn",
      step: "effort_unsupported",
    });
    expect(store.get(THREAD)?.effort).toBe("high");
  });

  test("saves the effort so the thread runs at it after a restart", async () => {
    const before = fakeClaude(SUBSCRIPTION);
    const first = await harness([before]);
    await completeTurn(first.turns, first.sent, before, 10, undefined, "max");
    await until(() => first.store.get(THREAD)?.effort === "max");

    const after = fakeClaude(SUBSCRIPTION);
    const restarted = await harness([after]);
    await completeTurn(restarted.turns, restarted.sent, after, 11);

    expect(restarted.threads.effortOf(THREAD)).toBe("max");
    expect(after.efforts()).toEqual(["max"]);
  });

  test("registers a thread switched to Claude by turn/start with that turn's effort", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store } = await harness([claude], { adopt: false });
    const request = turnStart(10, "hello");

    turns.startTurn(
      {
        ...request,
        params: { ...request.params, model: MODEL, cwd: dir, effort: "low" },
      },
      undefined,
    );
    await until(() => responseTo(sent, 10) !== undefined);

    expect(store.get(THREAD)?.effort).toBe("low");
    await until(() => claude.efforts().length === 1);
    expect(claude.efforts()).toEqual(["low"]);
  });

  test("saves an effort picked while the thread's first turn registers it", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const firstWrite = createGate();
    let writes = 0;
    const { turns, threads, store } = await harness([claude], {
      files: {
        writeState: async (target, content) => {
          if (++writes === 1) await firstWrite.promise;
          return writeFileAtomic(target, content);
        },
      },
    });

    turns.startTurn(withEffort(turnStart(10, "hello"), "low"), undefined);
    await until(() => writes === 1);
    threads.selectEffort(THREAD, "max");
    firstWrite.open();
    await until(() => store.get(THREAD)?.effort === "max");

    expect(threads.effortOf(THREAD)).toBe("max");
  });

  test("keeps an effort the store failed to save while the bridge runs", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    let writes = 0;
    const { turns, threads, sent, events } = await harness([claude], {
      files: {
        writeState: async (target, content) =>
          ++writes <= 2 ? writeFileAtomic(target, content) : diskFull(target),
      },
    });
    await completeTurn(turns, sent, claude, 10);

    threads.selectEffort(THREAD, "max");
    await until(() =>
      events.some((event) => event.step === "effort_not_saved"),
    );
    await completeTurn(turns, sent, claude, 11);

    expect(events).toContainEqual({
      event: "claude_turn",
      step: "effort_not_saved",
      error: "StatePersistFailed",
    });
    expect(claude.efforts()).toEqual(["high", "max"]);
  });
});

describe("token usage", () => {
  test("adds each turn's usage to its own thread's total and reports it before the turn completes", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await twoWorkers([first, second]);
    await until(() => second.started());

    first.emit(sdk(success()));
    await until(() => usageTotals(sent).length === 1);
    second.emit(sdk(success()));
    await until(() => usageTotals(sent).length === 2);
    await completeTurn(turns, sent, first, 12);

    expect(usageTotals(sent)).toEqual([
      { threadId: THREAD, total: 40, window: 200_000 },
      { threadId: OTHER_THREAD, total: 40, window: 200_000 },
      { threadId: THREAD, total: 80, window: 200_000 },
    ]);
    const methods = sent.map((message) => message.method);
    expect(methods.indexOf("thread/tokenUsage/updated")).toBeGreaterThan(-1);
    expect(methods.indexOf("thread/tokenUsage/updated")).toBeLessThan(
      methods.indexOf("turn/completed"),
    );
  });
});

describe("plan", () => {
  test("keeps a thread's tasks across turns", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    await taskTurn(turns, sent, claude, 10, [
      taskCall("tool-1", "TaskCreate", { subject: "Alpha", description: "" }),
      taskResult("tool-1", { task: { id: "1", subject: "Alpha" } }),
    ]);
    await taskTurn(turns, sent, claude, 11, [
      taskCall("tool-2", "TaskUpdate", { taskId: "1", status: "completed" }),
      taskResult("tool-2", { success: true, taskId: "1", updatedFields: [] }),
    ]);

    expect(
      sent
        .filter((message) => message.method === "turn/plan/updated")
        .map(({ params }) => ({ turnId: params.turnId, plan: params.plan })),
    ).toEqual([
      { turnId: "turn-1", plan: [{ step: "Alpha", status: "pending" }] },
      { turnId: "turn-2", plan: [{ step: "Alpha", status: "completed" }] },
    ]);
  });
});

describe("turn metrics", () => {
  test("keeps one Claude session across turns and logs each result's model, effort, tokens and durations with a start time only for the first", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    let clock = 1_700_000_000_000;
    const { turns, sent, events, settings } = await harness([claude], {
      now: () => (clock += 10),
    });

    await completeTurn(turns, sent, claude, 10);
    await completeTurn(turns, sent, claude, 11);

    const metrics = {
      event: "claude_turn",
      step: "metrics",
      model: MODEL,
      effort: "high",
      compaction: false,
      totalTokens: 40,
      inputTokens: 34,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 10,
      outputTokens: 6,
      reasoningOutputTokens: 0,
      firstMessageMs: expect.any(Number),
      turnMs: expect.any(Number),
    } as const;
    expect(settings).toHaveLength(1);
    expect(completedTurnStatuses(sent)).toEqual(["completed", "completed"]);
    expect(events.filter((event) => event.step === "metrics")).toEqual([
      { ...metrics, sessionStartMs: expect.any(Number) },
      { ...metrics, sessionStartMs: null },
    ]);
  });

  test("measures the Claude start from the session request, the first message from the send and the turn from its start", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const gate = createGate();
    let clock = 0;
    const { turns, sent, events, settings } = await harness([claude], {
      now: () => clock,
      beforeStart: gate.promise,
    });

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => settings.length === 1);
    clock = 50;
    gate.open();
    await until(() => claude.started());
    expect(await firstPrompt(claude.prompt())).toBe("hello");
    clock = 120;
    claude.emit(sdk(answer("msg-1", "hi")));
    await until(() => claude.drained());
    clock = 200;
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    expect(events.find((event) => event.step === "metrics")).toMatchObject({
      sessionStartMs: 50,
      firstMessageMs: 70,
      turnMs: 200,
    });
  });

  test("measures the first message from the first reply of the main conversation, past status and subagent messages", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    let clock = 0;
    const { turns, sent, events } = await harness([claude], {
      now: () => clock,
    });

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    expect(await firstPrompt(claude.prompt())).toBe("hello");
    clock = 3;
    claude.emit(sdk({ type: "system", subtype: "status", status: null }));
    await until(() => claude.drained());
    clock = 23;
    claude.emit(
      sdk({
        ...answer("msg-sub", "working"),
        parent_tool_use_id: "toolu-task",
      }),
    );
    await until(() => claude.drained());
    clock = 63;
    claude.emit(
      sdk({
        type: "stream_event",
        event: { type: "ping" },
        parent_tool_use_id: null,
      }),
    );
    await until(() => claude.drained());
    clock = 93;
    claude.emit(sdk(answer("msg-1", "hi")));
    await until(() => claude.drained());
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    expect(events.find((event) => event.step === "metrics")).toMatchObject({
      firstMessageMs: 63,
    });
  });

  test("logs no first message for a turn that ends before Claude replies", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, events } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());
    claude.emit(sdk({ type: "system", subtype: "status", status: null }));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    expect(events.find((event) => event.step === "metrics")).toMatchObject({
      firstMessageMs: null,
    });
  });

  test("logs the result that ends a Claude turn before a queued steer runs", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, events } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.steerTurn(steer(30, "turn-1", "also this"));
    const [prompt, steered] = await readPrompts(claude, 2);
    claude.emit(sdk(success([prompt?.uuid], 1)));
    await until(() => events.some((event) => event.step === "metrics"));
    const beforeSteer = events.filter(
      (event) => event.step === "metrics",
    ).length;
    claude.emit(sdk(success([steered?.uuid])));
    await until(() => turnCompleted(sent) !== undefined);

    expect({
      beforeSteer,
      after: events.filter((event) => event.step === "metrics").length,
    }).toEqual({ beforeSteer: 1, after: 2 });
  });
});

const usageTotals = (sent: Sent[]) =>
  sent
    .filter((message) => message.method === "thread/tokenUsage/updated")
    .map(({ params }) => ({
      threadId: params.threadId,
      total: params.tokenUsage.total.totalTokens,
      window: params.tokenUsage.modelContextWindow,
    }));

const HAIKU = "claude-haiku-4-5";

const taskTurn = async (
  turns: ReturnType<typeof createTurnController>,
  sent: Sent[],
  claude: ReturnType<typeof fakeClaude>,
  id: number,
  messages: object[],
) => {
  const before = completedTurnStatuses(sent).length;
  turns.startTurn(turnStart(id, `prompt ${id}`), undefined);
  await until(() => responseTo(sent, id) !== undefined);
  for (const message of messages) claude.emit(sdk(message));
  claude.emit(sdk(success()));
  await until(() => completedTurnStatuses(sent).length > before);
};

const taskCall = (toolUseId: string, name: string, input: object) => ({
  type: "assistant",
  message: {
    id: `msg-${toolUseId}`,
    content: [{ type: "tool_use", id: toolUseId, name, input }],
    stop_reason: "tool_use",
  },
  parent_tool_use_id: null,
});

const taskResult = (toolUseId: string, output: object) => ({
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: "ok",
        is_error: false,
      },
    ],
  },
  parent_tool_use_id: null,
  tool_use_result: output,
});
