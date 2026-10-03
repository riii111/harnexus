import { describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  EffortLevel,
  PermissionUpdate,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Result } from "better-result";
import { createModelCatalog, effortRule } from "../../infra/claude/models.ts";
import { startClaudeSession } from "../../infra/claude/session.ts";
import { fakeClaude } from "../../infra/claude/testing/fake-claude.ts";
import { createEmptyFile, writeFileAtomic } from "../../runtime/fs.boundary.ts";
import type { createTurnController } from "../controller.ts";
import {
  ALLOWED_TOOLS,
  answer,
  appRequest,
  askTool,
  BUILT_IN_EFFORTS,
  claudeDir,
  completedItems,
  completedTurnStatuses,
  completedTurns,
  completeTurn,
  createGate,
  dir,
  diskFull,
  firstPrompt,
  harness,
  interrupt,
  MODEL,
  OTHER_MODEL,
  OTHER_THREAD,
  OUTCOME_UNKNOWN,
  promptsUntil,
  REFUSED,
  reply,
  resolvedRequests,
  responseTo,
  restartedWithUnknownOutcome,
  result,
  type Sent,
  SUBSCRIPTION,
  sdk,
  settle,
  startedTurns,
  success,
  THREAD,
  turnCompleted,
  turnStart,
  twoWorkers,
  until,
  useTempDir,
  withEffort,
} from "../testing/harness.ts";

useTempDir();

describe("tool approval", () => {
  test("asks the app about the tool's item and allows what it accepts", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await startedTurn(claude);

    const decision = askTool(claude, "Bash", { command: "rm -rf build" });
    const request = await appRequest(sent);
    turns.answerRequest({ id: request.id, result: { decision: "accept" } });

    expect(await decision).toEqual({ behavior: "allow" });
    const started = sent.find(
      (m) =>
        m.method === "item/started" &&
        m.params.item.type === "commandExecution",
    );
    expect(request).toMatchObject({
      id: "harnexus-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: THREAD,
        turnId: "turn-1",
        itemId: started?.params.item.id,
        command: "rm -rf build",
      },
    });
    expect(resolvedRequests(sent)).toEqual(["harnexus-1"]);
  });

  test("hands Claude its suggested rule to save when the app always allows a command", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await startedTurn(claude);
    const rule: PermissionUpdate = {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
      behavior: "allow",
      destination: "localSettings",
    };

    const decision = askTool(
      claude,
      "Bash",
      { command: "npm test" },
      { suggestions: [rule] },
    );
    const request = await appRequest(sent);
    turns.answerRequest({
      id: request.id,
      result: {
        decision: {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: ["npm", "test"],
          },
        },
      },
    });

    expect(request.params.proposedExecpolicyAmendment).toEqual(["npm", "test"]);
    expect(await decision).toEqual({
      behavior: "allow",
      updatedPermissions: [{ ...rule, destination: "projectSettings" }],
    });
  });

  test("saves no rule when the SDK forbids a persistent allow", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await startedTurn(claude);
    const rule: PermissionUpdate = {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
      behavior: "allow",
      destination: "localSettings",
    };

    const decision = askTool(
      claude,
      "Bash",
      { command: "npm test" },
      { suggestions: [rule], suppressAlwaysAllowRule: true },
    );
    const request = await appRequest(sent);
    turns.answerRequest({
      id: request.id,
      result: {
        decision: {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: ["npm", "test"],
          },
        },
      },
    });

    expect(request.params.availableDecisions).toEqual([
      "accept",
      "acceptForSession",
      "decline",
      "cancel",
    ]);
    expect(await decision).toEqual({ behavior: "allow" });
  });

  test("shows a tool the app declined as declined", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await startedTurn(claude);

    const decision = askTool(claude, "Bash", { command: "rm -rf build" });
    const request = await appRequest(sent);
    turns.answerRequest({ id: request.id, result: { decision: "decline" } });
    expect((await decision)?.behavior).toBe("deny");
    claude.emit(sdk(bashCall("tool-1")));
    claude.emit(sdk(toolError("tool-1")));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    const commands = sent.filter(
      (m) =>
        m.method === "item/started" &&
        m.params.item.type === "commandExecution",
    );
    expect(commands).toHaveLength(1);
    const command = completedItems(sent).find(
      (item) => item.type === "commandExecution",
    );
    expect(command).toMatchObject({ status: "declined" });
  });

  test("denies a tool whose request the app answers with an error", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await startedTurn(claude);

    const decision = askTool(claude, "Write", {
      file_path: "/w/a.ts",
      content: "",
    });
    const request = await appRequest(sent);
    turns.answerRequest({ id: request.id, error: { code: -1, message: "no" } });

    expect(request.method).toBe("item/fileChange/requestApproval");
    expect((await decision)?.behavior).toBe("deny");
  });

  test("returns the app's answers to Claude's question", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await startedTurn(claude);
    const input = {
      questions: [
        {
          question: "Which?",
          header: "Pick",
          options: [
            { label: "A", description: "the first" },
            { label: "B", description: "the second" },
          ],
          multiSelect: false,
        },
      ],
    };

    const decision = askTool(claude, "AskUserQuestion", input);
    const request = await appRequest(sent);
    turns.answerRequest({
      id: request.id,
      result: { answers: { "question-1": { answers: ["A"] } } },
    });

    expect(request.method).toBe("item/tool/requestUserInput");
    expect(await decision).toEqual({
      behavior: "allow",
      updatedInput: { ...input, answers: { "Which?": "A" } },
    });
  });

  test("asks about a subagent's tool on an item of its own while its agent runs in the turn", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { sent } = await startedTurn(claude);
    claude.emit(
      sdk({
        type: "assistant",
        message: {
          id: "msg-1",
          content: [
            { type: "tool_use", id: "agent-1", name: "Agent", input: {} },
          ],
          stop_reason: null,
        },
        parent_tool_use_id: null,
      }),
    );
    await until(() => claude.drained());

    askTool(claude, "Bash", { command: "ls" }, { agentID: "agent-1" });
    const request = await appRequest(sent);

    const started = sent.find(
      (m) =>
        m.method === "item/started" &&
        m.params.item.type === "commandExecution",
    );
    expect(request).toMatchObject({
      method: "item/commandExecution/requestApproval",
      params: { itemId: started?.params.item.id, command: "ls" },
    });
  });

  test("asks about a background subagent's tool without adding an item the turn would close", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { sent } = await startedTurn(claude);

    askTool(claude, "Bash", { command: "ls" }, { agentID: "agent-1" });
    const request = await appRequest(sent);

    expect(request.method).toBe("item/tool/requestUserInput");
    expect(request.params.itemId).toBe("turn-1-tool-1");
    expect(
      sent.filter(
        (m) =>
          m.method === "item/started" && m.params.item.type !== "userMessage",
      ),
    ).toEqual([]);
  });

  test("holds a tool asked while the app receives turn/completed in a turn of its own after that one", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const asked: { decision?: ReturnType<typeof askTool> } = {};
    const { turns, sent } = await harness([claude], {
      onSend: (message) => {
        if (
          message.method === "turn/completed" &&
          asked.decision === undefined
        ) {
          asked.decision = askTool(claude, "Bash", { command: "ls" });
        }
      },
    });
    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());

    claude.emit(sdk(success()));
    const request = await appRequest(sent);
    turns.answerRequest({ id: request.id, result: ALLOWED });

    expect(await asked.decision).toEqual({ behavior: "allow" });
    expect(request.params.turnId).toBe("turn-2");
    await until(() => completedTurnStatuses(sent).length === 2);
    expect(completedTurns(sent)).toMatchObject([
      { id: "turn-1", status: "completed" },
      { id: "turn-2", status: "completed" },
    ]);
  });

  test.each<{
    name: string;
    stop: (turns: Turns, claude: ReturnType<typeof fakeClaude>) => void;
    status: string | undefined;
  }>([
    {
      name: "the turn is interrupted",
      stop: (turns) => turns.interruptTurn(interrupt(20, "turn-1")),
      status: undefined,
    },
    {
      name: "the bridge closes",
      stop: (turns) => turns.closeAll(),
      status: undefined,
    },
    {
      name: "the turn fails",
      stop: (_turns, claude) => claude.fail(new Error("socket closed")),
      status: "failed",
    },
  ])("denies a waiting tool and closes its prompt when $name", async ({
    stop,
    status,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const { turns, sent } = await startedTurn(claude);

    const decision = askTool(claude, "Bash", { command: "ls" });
    const request = await appRequest(sent);
    stop(turns, claude);

    expect((await decision)?.behavior).toBe("deny");
    expect(turnCompleted(sent)?.status).toBe(status);
    expect(resolvedRequests(sent)).toEqual([request.id]);
  });

  test("denies a waiting tool when Claude aborts the request", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { sent } = await startedTurn(claude);
    const abort = new AbortController();

    const decision = askTool(
      claude,
      "Bash",
      { command: "ls" },
      { signal: abort.signal },
    );
    const request = await appRequest(sent);
    abort.abort();

    expect((await decision)?.behavior).toBe("deny");
    expect(resolvedRequests(sent)).toEqual([request.id]);
  });
});

describe("tool approval that must default to no", () => {
  test("asks for the approving word without choices", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { sent } = await startedTurn(claude);

    askTool(claude, "Bash", { command: "ls" }, { defaultToNo: true });
    const request = await appRequest(sent);

    expect(request.method).toBe("item/tool/requestUserInput");
    expect(request.params.questions).toMatchObject([
      { question: expect.stringContaining('Type "Allow"'), options: null },
    ]);
  });

  test.each([
    { name: "a choice number", typed: "2", expected: "deny" },
    { name: "the approving word", typed: "Allow", expected: "allow" },
  ])("answers $expected to $name", async ({ typed, expected }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await startedTurn(claude);

    const decision = askTool(
      claude,
      "Bash",
      { command: "ls" },
      { defaultToNo: true },
    );
    const request = await appRequest(sent);
    turns.answerRequest({
      id: request.id,
      result: { answers: { approval: { answers: [typed] } } },
    });

    expect((await decision)?.behavior).toBe(expected);
  });
});

describe("permission mode", () => {
  test.each([
    { name: "plan", mode: "plan", expected: "plan" },
    { name: "default", mode: "default", expected: "default" },
  ])("runs a turn in the app's $name mode as Claude's $expected mode", async ({
    mode,
    expected,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns } = await harness([claude]);
    const request = turnStart(10, "hello");

    turns.startTurn(
      {
        ...request,
        params: {
          ...request.params,
          collaborationMode: { mode, settings: { model: MODEL } },
        },
      },
      undefined,
    );
    await until(() => claude.modes().length === 1);

    expect(claude.modes()).toEqual([expected]);
  });

  test("runs a turn without a mode in the mode picked earlier", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns } = await harness([claude]);

    turns.selectMode(THREAD, "plan");
    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.modes().length === 1);

    expect(claude.modes()).toEqual(["plan"]);
  });
});

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
    const { turns, sent } = await harness([claude]);
    turns.startTurn(withEffort(turnStart(10, "hello"), "low"), undefined);
    await until(() => claude.efforts().length === 1);

    turns.selectEffort(THREAD, "max");
    claude.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 1);
    const whileRunning = [...claude.efforts()];
    await completeTurn(turns, sent, claude, 11);

    expect(whileRunning).toEqual(["low"]);
    expect(claude.efforts()).toEqual(["low", "max"]);
  });

  test("runs a queued turn at the effort it was accepted with", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    turns.startTurn(withEffort(turnStart(10, "hello"), "low"), undefined);
    await until(() => claude.efforts().length === 1);

    turns.startTurn(withEffort(turnStart(11, "next"), "high"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    turns.selectEffort(THREAD, "max");
    claude.emit(sdk(success()));
    await until(() => claude.efforts().length === 2);

    expect(claude.efforts()).toEqual(["low", "high"]);
  });

  test("runs a turn with no level picked at the default the app shows for the thread", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns } = await harness([claude], {
      effortRule: effortRule({ effortLevel: "low" }, BUILT_IN_EFFORTS),
    });

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.efforts().length === 1);

    expect(claude.efforts()).toEqual(["low"]);
    expect(turns.effortOf(THREAD)).toBe("low");
  });

  test("runs a picked level above the settings' cap at the cap the app shows", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns } = await harness([claude], {
      effortRule: effortRule({ maxEffortLevel: "low" }, BUILT_IN_EFFORTS),
    });

    turns.startTurn(withEffort(turnStart(10, "hello"), "max"), undefined);
    await until(() => claude.efforts().length === 1);

    expect(claude.efforts()).toEqual(["low"]);
    expect(turns.effortOf(THREAD)).toBe("low");
  });

  test("runs a thread on a model no list names yet at its saved level", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const catalog = createModelCatalog();
    const { turns } = await harness([claude], {
      effortRule: effortRule({}, catalog.effortsOf),
    });
    const request = withEffort(turnStart(10, "hello"), "xhigh");

    turns.startTurn(
      { ...request, params: { ...request.params, model: "claude-sonnet-5-5" } },
      undefined,
    );
    await until(() => claude.efforts().length === 1);

    expect(claude.efforts()).toEqual(["xhigh"]);
    expect(turns.effortOf(THREAD)).toBe("xhigh");
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

    expect(restarted.turns.effortOf(THREAD)).toBe("max");
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
    const { turns, store } = await harness([claude], {
      files: {
        writeState: async (target, content) => {
          if (++writes === 1) await firstWrite.promise;
          return writeFileAtomic(target, content);
        },
      },
    });

    turns.startTurn(withEffort(turnStart(10, "hello"), "low"), undefined);
    await until(() => writes === 1);
    turns.selectEffort(THREAD, "max");
    firstWrite.open();
    await until(() => store.get(THREAD)?.effort === "max");

    expect(turns.effortOf(THREAD)).toBe("max");
  });

  test("keeps an effort the store failed to save while the bridge runs", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    let writes = 0;
    const { turns, sent, events } = await harness([claude], {
      files: {
        writeState: async (target, content) =>
          ++writes <= 2 ? writeFileAtomic(target, content) : diskFull(target),
      },
    });
    await completeTurn(turns, sent, claude, 10);

    turns.selectEffort(THREAD, "max");
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
    await until(() => claude.started());
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

describe("canceling Claude session startup", () => {
  test("cancels a stuck account lookup while preserving a slow valid startup and its next turn", async () => {
    const accountGate = createGate();
    const normalAccountGate = createGate();
    const first = fakeClaude(new Error("account lookup failed"), {
      accountAnswered: accountGate.promise,
    });
    const second = fakeClaude(SUBSCRIPTION, {
      accountAnswered: normalAccountGate.promise,
    });
    const { turns, sent, settings } = await harness([first, second]);

    turns.startTurn(turnStart(10, "first"), undefined);
    await until(() => first.started());
    turns.interruptTurn(interrupt(20, "turn-1"));
    await until(() => turnCompleted(sent) !== undefined);

    expect(turnCompleted(sent)?.status).toBe("interrupted");
    expect(first.closes()).toBe(1);
    expect(first.interrupts()).toBe(0);
    expect(await first.prompts()).toEqual([]);

    turns.startTurn(turnStart(11, "second"), undefined);
    await until(() => second.started());
    expect(second.closes()).toBe(0);
    normalAccountGate.open();
    await normalAccountGate.promise;
    expect(await firstPrompt(second.prompt())).toBe("second");
    second.emit(sdk(answer("msg-2", "reply")));
    await until(() => second.drained());
    second.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 2);

    accountGate.open();
    await accountGate.promise;
    turns.startTurn(turnStart(12, "third"), undefined);
    await until(() => responseTo(sent, 12) !== undefined);
    expect(await firstPrompt(second.prompt())).toBe("third");
    second.emit(sdk(answer("msg-3", "reply")));
    await until(() => second.drained());
    second.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 3);

    expect(settings).toHaveLength(2);
    expect(first.closes()).toBe(1);
  });

  test("closes a late successful start without starting its pump or replacing the current session", async () => {
    const lateStartGate = createGate();
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([first, second], {
      startSession: async (session, signal, fake) => {
        if (fake === first) {
          await lateStartGate.promise;
          const started = await startClaudeSession(session, fake.runtime);
          if (started.isOk()) {
            fake.emit(sdk(answer("msg-late", "stale startup output")));
          }
          return started;
        }
        return startClaudeSession(session, fake.runtime, signal);
      },
    });

    turns.startTurn(turnStart(10, "first"), undefined);
    await until(() => settings.length === 1);
    turns.interruptTurn(interrupt(20, "turn-1"));
    await until(() => completedTurnStatuses(sent).length === 1);

    turns.startTurn(turnStart(11, "second"), undefined);
    await until(() => second.started());
    expect(await firstPrompt(second.prompt())).toBe("second");
    second.emit(sdk(answer("msg-2", "reply")));
    await until(() => second.drained());
    second.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 2);

    lateStartGate.open();
    await until(() => first.closes() === 1);
    expect(first.nextCalls()).toBe(0);
    expect(await first.prompts()).toEqual([]);
    expect(JSON.stringify(sent)).not.toContain("stale startup output");

    turns.startTurn(turnStart(12, "reuse second"), undefined);
    await until(() => responseTo(sent, 12) !== undefined);
    expect(await firstPrompt(second.prompt())).toBe("reuse second");
    second.emit(sdk(answer("msg-3", "reply")));
    await until(() => second.drained());
    second.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 3);

    expect(settings).toHaveLength(2);
    turns.closeAll();
  });

  test("interrupts a prior-record lookup and reuses the existing session", async () => {
    const advancedGate = createGate();
    const advancedFinished = createGate();
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    let recordReads = 0;
    const { turns, sent, settings, store, gates } = await harness(
      [first, second],
      {
        lastRecord: async () => {
          recordReads += 1;
          if (recordReads === 2) {
            await advancedGate.promise;
            advancedFinished.open();
            return Result.ok("record-after");
          }
          return Result.ok("record-before");
        },
        lookupSession: async () => Result.ok(true),
      },
    );

    await completeTurn(turns, sent, first, 10);
    expect(await firstPrompt(first.prompt())).toBe("prompt 10");
    await until(() => recordReads === 1);
    turns.startTurn(turnStart(11, "stop during lookup"), undefined);
    await until(() => recordReads === 2);
    turns.interruptTurn(interrupt(20, "turn-2"));
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(first.interrupts()).toBe(0);
    expect(first.closes()).toBe(0);
    expect(gates.slice(0, 2)).toEqual(["accept", "stop"]);

    turns.startTurn(turnStart(12, "continue after interrupt"), undefined);
    await until(() => responseTo(sent, 12) !== undefined);
    expect(await firstPrompt(first.prompt())).toBe("continue after interrupt");
    expect(gates).toEqual(["accept", "stop", "stop", "accept"]);
    first.emit(sdk(answer("msg-3", "reply")));
    await until(() => first.drained());
    first.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 3);

    advancedGate.open();
    await advancedFinished.promise;
    await until(() => store.get(THREAD)?.runState === "idle");
    expect(second.started()).toBe(false);
    expect(settings).toHaveLength(1);
    expect(first.closes()).toBe(0);
  });

  test("closeAll completes a turn waiting on a prior-record lookup", async () => {
    const advancedGate = createGate();
    const advancedFinished = createGate();
    const first = fakeClaude(SUBSCRIPTION);
    let recordReads = 0;
    const { turns, sent, settings } = await harness([first], {
      lastRecord: async () => {
        recordReads += 1;
        if (recordReads === 2) {
          await advancedGate.promise;
          advancedFinished.open();
          return Result.ok("record-after");
        }
        return Result.ok("record-before");
      },
      lookupSession: async () => Result.ok(true),
    });

    await completeTurn(turns, sent, first, 10);
    turns.startTurn(turnStart(11, "close during lookup"), undefined);
    await until(() => recordReads === 2);
    turns.closeAll();
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(completedTurnStatuses(sent).at(-1)).toBe("failed");
    expect(first.closes()).toBe(1);

    advancedGate.open();
    await advancedFinished.promise;
    expect(settings).toHaveLength(1);
    expect(first.closes()).toBe(1);
  });

  test("does not let a cancelled resume lookup replace a later session", async () => {
    const resumeGate = createGate();
    const staleLookupFinished = createGate();
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    let lookups = 0;
    const { turns, sent, settings } = await harness([first, second], {
      lookupSession: async () => {
        lookups += 1;
        if (lookups === 1) {
          await resumeGate.promise;
          staleLookupFinished.open();
        }
        return Result.ok(true);
      },
    });

    turns.startTurn(turnStart(10, "first"), undefined);
    await until(() => first.started());
    expect(await firstPrompt(first.prompt())).toBe("first");
    first.emit(sdk(answer("msg-1", "partial")));
    await until(() => first.drained());
    first.fail(new Error("socket closed"));
    await until(() => turnCompleted(sent) !== undefined);

    turns.startTurn(turnStart(11, "cancelled resume"), undefined);
    await until(() => lookups === 1);
    turns.interruptTurn(interrupt(20, "turn-2"));
    await until(() => completedTurnStatuses(sent).length === 2);

    turns.startTurn(turnStart(12, "new session"), undefined);
    await until(() => second.started());
    expect(await firstPrompt(second.prompt())).toBe("new session");
    second.emit(sdk(answer("msg-2", "reply")));
    await until(() => second.drained());
    second.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 3);

    resumeGate.open();
    await staleLookupFinished.promise;
    turns.startTurn(turnStart(13, "reuse new session"), undefined);
    await until(() => responseTo(sent, 13) !== undefined);
    expect(await firstPrompt(second.prompt())).toBe("reuse new session");
    second.emit(sdk(answer("msg-3", "reply")));
    await until(() => second.drained());
    second.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 4);

    expect(lookups).toBe(2);
    expect(settings).toHaveLength(2);
    expect(settings[1]).toMatchObject({ resume: "se-1" });
    turns.closeAll();
  });

  test("closeAll releases an account lookup and closes the query once", async () => {
    const accountGate = createGate();
    const claude = fakeClaude(SUBSCRIPTION, {
      accountAnswered: accountGate.promise,
    });
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.closeAll();
    await until(() => turnCompleted(sent) !== undefined);

    expect(turnCompleted(sent)?.status).toBe("failed");
    expect(claude.closes()).toBe(1);
    expect(await claude.prompts()).toEqual([]);
    accountGate.open();
    await accountGate.promise;
    expect(claude.closes()).toBe(1);
  });
});

describe("session ids", () => {
  test("resumes from the session id Claude reported even when saving it failed", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    let writes = 0;
    const { turns, sent, settings, events } = await harness([first, second], {
      files: {
        writeState: async (target, content) =>
          ++writes === 1 ? writeFileAtomic(target, content) : diskFull(target),
      },
    });

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => first.started());
    first.emit(sdk(answer("msg-1", "partial")));
    first.fail(new Error("socket closed"));
    await until(() => turnCompleted(sent) !== undefined);
    await completeTurn(turns, sent, second, 11);

    expect(events).toContainEqual({
      event: "claude_turn",
      step: "session_not_saved",
      error: "StatePersistFailed",
    });
    expect(settings[1]).toMatchObject({ resume: "se-1" });
  });
});

describe("a fork of a Claude thread", () => {
  // Claude names a project folder after its directory with every other character as a hyphen.
  const writeSourceRecord = async (uuids: string[]) => {
    const folder = join(
      claudeDir(),
      "projects",
      dir.replace(/[^a-zA-Z0-9]/g, "-"),
    );
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "se-1.jsonl"),
      uuids
        .map((uuid) => `${JSON.stringify({ type: "assistant", uuid })}\n`)
        .join(""),
    );
  };

  const forkTurn = async (
    started: Awaited<ReturnType<typeof harness>>,
    claude: ReturnType<typeof fakeClaude>,
    id: number,
  ) => {
    started.turns.startTurn(turnStart(id, "aside", OTHER_THREAD), undefined);
    await until(() => responseTo(started.sent, id) !== undefined);
    claude.emit(sdk({ ...answer(`msg-${id}`, "ok"), session_id: "se-fork" }));
    claude.emit(sdk({ ...success(), session_id: "se-fork" }));
    await until(() => completedTurnStatuses(started.sent).length === 2);
  };

  // The source's turn leaves its conversation as se-1, whose record ends at the given records.
  const forkAfterSource = async (
    started: Awaited<ReturnType<typeof harness>>,
    source: ReturnType<typeof fakeClaude>,
    records: string[],
  ) => {
    await completeTurn(started.turns, started.sent, source, 10);
    if (records.length > 0) await writeSourceRecord(records);
    await started.turns.adoptFork(
      OTHER_THREAD,
      { model: MODEL, cwd: dir },
      THREAD,
    );
  };

  test("starts its own conversation from the source's and leaves the source's alone", async () => {
    const source = fakeClaude(SUBSCRIPTION);
    const fork = fakeClaude(SUBSCRIPTION);
    const started = await harness([source, fork]);
    await forkAfterSource(started, source, ["a-1"]);

    await forkTurn(started, fork, 11);

    expect(started.settings[1]).toMatchObject({
      resume: "se-1",
      forkSession: true,
      resumeAt: "a-1",
    });
    await until(() => started.store.get(OTHER_THREAD)?.sessionId === "se-fork");
    expect(started.store.get(THREAD)?.sessionId).toBe("se-1");
  });

  test("leaves out what the source said after the fork", async () => {
    const source = fakeClaude(SUBSCRIPTION);
    const fork = fakeClaude(SUBSCRIPTION);
    const started = await harness([source, fork]);
    await forkAfterSource(started, source, ["a-1"]);
    await writeSourceRecord(["a-1", "a-2"]);

    await forkTurn(started, fork, 11);

    expect(started.settings[1]).toMatchObject({ resumeAt: "a-1" });
  });

  test("starts a conversation of its own when the source had said nothing when forked, even once it has", async () => {
    const source = fakeClaude(SUBSCRIPTION);
    const fork = fakeClaude(SUBSCRIPTION);
    const started = await harness([source, fork]);
    await forkAfterSource(started, source, []);
    await writeSourceRecord(["a-1"]);

    await forkTurn(started, fork, 11);

    expect(started.settings[1]?.resume).toBeUndefined();
    expect(started.settings[1]?.forkSession).toBeUndefined();
  });

  test("starts a conversation of its own when the source's is gone", async () => {
    const source = fakeClaude(SUBSCRIPTION);
    const fork = fakeClaude(SUBSCRIPTION);
    const started = await harness([source, fork], {
      missingSessions: ["se-1"],
    });
    await forkAfterSource(started, source, ["a-1"]);

    await forkTurn(started, fork, 11);

    expect(started.settings[1]?.resume).toBeUndefined();
    expect(started.settings[1]?.forkSession).toBeUndefined();
  });

  test("starts a conversation of its own when the source had none when forked", async () => {
    const source = fakeClaude(SUBSCRIPTION);
    const fork = fakeClaude(SUBSCRIPTION);
    const started = await harness([source, fork]);
    await started.turns.adoptFork(
      OTHER_THREAD,
      { model: MODEL, cwd: dir },
      THREAD,
    );
    await completeTurn(started.turns, started.sent, source, 10);

    await forkTurn(started, fork, 11);

    expect(started.settings[1]?.resume).toBeUndefined();
  });

  test("fails the turn without starting Claude when the source's record could not be read at the fork", async () => {
    const source = fakeClaude(SUBSCRIPTION);
    const fork = fakeClaude(SUBSCRIPTION);
    const started = await harness([source, fork]);
    // A project folder that links to itself cannot be listed.
    const project = join(claudeDir(), "projects", "-work-tree");
    await mkdir(join(claudeDir(), "projects"), { recursive: true });
    await symlink(project, project);
    await forkAfterSource(started, source, []);

    started.turns.startTurn(turnStart(11, "aside", OTHER_THREAD), undefined);
    await until(() => completedTurnStatuses(started.sent).length === 2);

    expect(completedTurns(started.sent).at(-1)).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("could not be read") },
    });
    expect(fork.started()).toBe(false);
    expect(started.settings).toHaveLength(1);
  });

  test("fails the turn and keeps the source's id off the fork when Claude stays in the source's conversation", async () => {
    const source = fakeClaude(SUBSCRIPTION);
    const fork = fakeClaude(SUBSCRIPTION);
    const started = await harness([source, fork]);
    await forkAfterSource(started, source, ["a-1"]);

    started.turns.startTurn(turnStart(11, "aside", OTHER_THREAD), undefined);
    await until(() => responseTo(started.sent, 11) !== undefined);
    fork.emit(sdk(answer("msg-11", "ok")));
    await until(() => completedTurnStatuses(started.sent).length === 2);

    expect(completedTurnStatuses(started.sent)).toEqual([
      "completed",
      "failed",
    ]);
    expect(started.store.get(OTHER_THREAD)?.sessionId ?? null).toBeNull();
    expect(started.store.get(THREAD)?.sessionId).toBe("se-1");
  });
});

describe("a saved session Claude no longer has", () => {
  test("fails the turn without starting Claude and starts a new conversation on the next turn", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const before = await harness([first]);
    await completeTurn(before.turns, before.sent, first, 10);
    await until(() => before.store.get(THREAD)?.runState === "idle");
    const second = fakeClaude(SUBSCRIPTION);

    const after = await harness([second], { missingSessions: ["se-1"] });
    after.turns.startTurn(turnStart(11, "hello"), undefined);
    await until(() => turnCompleted(after.sent) !== undefined);
    const failedStarted = second.started();
    await until(() => after.store.get(THREAD)?.sessionId === null);
    await completeTurn(after.turns, after.sent, second, 12);

    expect(turnCompleted(after.sent)).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("send again") },
    });
    expect(failedStarted).toBe(false);
    expect(after.settings).toHaveLength(1);
    expect(after.settings[0]?.resume).toBeUndefined();
    expect(after.events).toContainEqual({
      event: "claude_turn",
      step: "session_missing",
    });
  });

  test("starts a new conversation after a lost session even when forgetting its id cannot be saved", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const before = await harness([first]);
    await completeTurn(before.turns, before.sent, first, 10);
    await until(() => before.store.get(THREAD)?.runState === "idle");
    const second = fakeClaude(SUBSCRIPTION);

    const after = await harness([second], {
      missingSessions: ["se-1"],
      files: { writeState: diskFull },
    });
    after.turns.startTurn(turnStart(11, "hello"), undefined);
    await until(() => turnCompleted(after.sent) !== undefined);
    await until(() =>
      after.events.some((event) => event.step === "session_not_saved"),
    );
    await completeTurn(after.turns, after.sent, second, 12);

    expect(after.store.get(THREAD)?.sessionId).toBe("se-1");
    expect(after.settings).toHaveLength(1);
    expect(after.settings[0]?.resume).toBeUndefined();
    expect(completedTurnStatuses(after.sent)).toEqual(["failed", "completed"]);
  });

  test("resumes the saved session when its record cannot be looked up", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const before = await harness([first]);
    await completeTurn(before.turns, before.sent, first, 10);
    await until(() => before.store.get(THREAD)?.runState === "idle");
    const second = fakeClaude(SUBSCRIPTION);

    const after = await harness([second], { sessionLookupFails: true });
    await completeTurn(after.turns, after.sent, second, 11);

    expect(after.settings[0]).toMatchObject({ resume: "se-1" });
    expect(completedTurnStatuses(after.sent)).toEqual(["completed"]);
  });
});

describe("Claude's own turns", () => {
  // A background task that reports back after the last turn ended starts a turn of Claude's own, which reaches the next turn ahead of its reply.
  test.each([
    { name: "for a background task", fields: {} },
    {
      name: "to continue its work",
      fields: { origin: { kind: "auto-continuation" } },
    },
    {
      name: "for a send of another client",
      fields: { origin: undefined, user_message_uuids: ["uuid-elsewhere"] },
    },
  ])("keeps the turn open through a turn Claude ran $name before taking the prompt", async ({
    fields,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    const [prompt] = await readPrompts(claude, 1);
    claude.emit(sdk(answer("msg-1", "the agent finished")));
    claude.emit(sdk(ownResult(fields)));
    await until(() => claude.drained());
    expect(completedTurnStatuses(sent)).toEqual([]);
    claude.emit(sdk(answer("msg-2", "hi")));
    claude.emit(sdk(success([prompt?.uuid])));
    await until(() => turnCompleted(sent) !== undefined);

    expect(completedTurnStatuses(sent)).toEqual(["completed"]);
    expect(turnCompleted(sent).items).toMatchObject([{ text: "hi" }]);
    expect(claude.closes()).toBe(0);
  });

  test("keeps a steer pending through a turn Claude ran on its own", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.steerTurn(steer(30, "turn-1", "also this"));
    const [prompt, steered] = await readPrompts(claude, 2);
    claude.emit(sdk(answer("msg-1", "first")));
    claude.emit(sdk(success([prompt?.uuid], 1)));
    claude.emit(sdk(answer("msg-2", "the agent finished")));
    claude.emit(sdk(ownResult()));
    await until(() => claude.drained());
    expect(completedTurnStatuses(sent)).toEqual([]);
    claude.emit(sdk(answer("msg-3", "second")));
    claude.emit(sdk(success([steered?.uuid])));
    await until(() => turnCompleted(sent) !== undefined);

    expect(completedTurnStatuses(sent)).toEqual(["completed"]);
    expect(turnCompleted(sent).items).toMatchObject([{ text: "second" }]);
    expect(claude.closes()).toBe(0);
  });

  // A prompt sent while Claude's own turn runs joins it, and the result then names it.
  test("ends the turn with a turn Claude started on its own that took the prompt", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    const [prompt] = await readPrompts(claude, 1);
    claude.emit(sdk(answer("msg-1", "hi")));
    claude.emit(sdk(ownResult({ user_message_uuids: [prompt?.uuid] })));
    await until(() => turnCompleted(sent) !== undefined);

    expect(completedTurnStatuses(sent)).toEqual(["completed"]);
  });
});

describe("subagent threads", () => {
  test("shows an agent Claude starts as a thread under the turn's thread until it completes", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, subagents } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    claude.emit(sdk(taskStarted("toolu-agent", 1)));
    claude.emit(sdk(taskNotification("toolu-agent")));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    const [child] = subagents.childrenOf(THREAD);
    expect(child).toMatchObject({ active: false, turnId: "turn-1" });
    expect(subagentEvents(sent)).toEqual([
      `${THREAD} turn-1 started ${child?.id}`,
      `${child?.id} active`,
      `${child?.id} idle`,
      `${THREAD} turn-1 completed ${child?.id}`,
    ]);
  });

  test("shows what an agent says in its own thread and not in the parent's turn", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, subagents } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    claude.emit(sdk(taskStarted("toolu-agent", 1)));
    claude.emit(
      sdk({
        type: "assistant",
        message: {
          id: "msg-sub",
          content: [
            {
              type: "tool_use",
              id: "toolu-ls",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
          stop_reason: null,
        },
        parent_tool_use_id: "toolu-agent",
      }),
    );
    claude.emit(sdk(taskNotification("toolu-agent")));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    const [child] = subagents.childrenOf(THREAD);
    const commands = completedItems(sent).filter(
      (item) => item.type === "commandExecution",
    );
    expect(commands).toHaveLength(1);
    expect(
      sent.find(
        (m) =>
          m.method === "item/completed" &&
          m.params.item.type === "commandExecution",
      )?.params.threadId,
    ).toBe(child?.id);
    expect(subagents.historyOf(child?.id ?? "")).toMatchObject([
      { turn: { status: "completed" } },
    ]);
  });

  test("reports an agent that finishes after its turn ended under that turn", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, subagents } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    claude.emit(sdk(taskStarted("toolu-agent", 1)));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);
    claude.emit(sdk(taskNotification("toolu-agent")));
    await until(() => subagents.childrenOf(THREAD)[0]?.active === false);

    expect(subagentEvents(sent).at(-1)).toBe(
      `${THREAD} turn-1 completed ${subagents.childrenOf(THREAD)[0]?.id}`,
    );
  });

  test.each([
    {
      name: "is killed",
      ending: {
        type: "system",
        subtype: "task_updated",
        task_id: "task-toolu-agent",
        patch: { status: "killed" },
      },
      turn: { status: "interrupted" },
    },
    {
      name: "is reported done by its task",
      ending: {
        type: "system",
        subtype: "task_updated",
        task_id: "task-toolu-agent",
        patch: { status: "completed" },
      },
      turn: { status: "completed" },
    },
    {
      name: "fails",
      ending: {
        ...taskNotification("toolu-agent"),
        status: "failed",
        summary: "API error: overloaded",
      },
      turn: { status: "failed", error: { message: "API error: overloaded" } },
    },
  ])("ends an agent's thread when the agent $name", async ({
    ending,
    turn,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, subagents } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    claude.emit(sdk(taskStarted("toolu-agent", 1)));
    claude.emit(sdk(ending));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    const [child] = subagents.childrenOf(THREAD);
    expect(child).toMatchObject({ active: false });
    expect(subagents.historyOf(child?.id ?? "")).toMatchObject([{ turn }]);
  });

  test("ends the agents of a session that closed", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, subagents } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    claude.emit(sdk(taskStarted("toolu-agent", 1)));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);
    claude.fail(new Error("Claude Code process exited with code 1"));
    await until(() => subagents.childrenOf(THREAD)[0]?.active === false);

    expect(subagentEvents(sent).at(-1)).toContain("completed");
  });

  test("leaves an agent a subagent starts inside its parent agent", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, subagents } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    claude.emit(sdk(taskStarted("toolu-inner", 2)));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    expect(subagents.childrenOf(THREAD)).toEqual([]);
    expect(subagentEvents(sent)).toEqual([]);
  });
});

describe("turns Claude starts between app turns", () => {
  test("shows a turn Claude started on its own as a turn nobody typed", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, events } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);

    claude.emit(sdk(INIT));
    claude.emit(sdk(answer("msg-2", "the agent finished")));
    claude.emit(sdk(ownResult()));
    await until(() => completedTurnStatuses(sent).length === 2);

    const own = sent.slice(sent.findIndex(isTurnStarted("turn-2")) - 1);
    expect(own.map((message) => message.method)).toEqual([
      "thread/status/changed",
      "turn/started",
      "item/started",
      "item/completed",
      "thread/tokenUsage/updated",
      "thread/status/changed",
      "turn/completed",
    ]);
    expect(completedTurns(sent)[1]).toMatchObject({
      id: "turn-2",
      status: "completed",
      items: [{ type: "agentMessage", text: "the agent finished" }],
    });
    expect(
      completedItems(own).filter((item) => item.type === "userMessage"),
    ).toEqual([]);
    expect(events).toContainEqual({ event: "claude_turn", step: "own_turn" });
    expect(claude.closes()).toBe(0);
  });

  test("asks the app about a tool Claude wants before its own turn is shown", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const decisions: ReturnType<typeof askTool>[] = [];
    const { turns, sent } = await harness([claude], {
      onSend: (message) => {
        if (isTurnStarted("turn-2")(message)) {
          decisions.push(askTool(claude, "Bash", { command: "ls" }));
        }
      },
    });
    await completeTurn(turns, sent, claude, 10);

    claude.emit(sdk(INIT));
    await until(() => decisions.length === 1);
    const request = await appRequest(sent);
    turns.answerRequest({ id: request.id, result: { decision: "accept" } });

    expect(await decisions[0]).toEqual({ behavior: "allow" });
    expect(request.params).toMatchObject({ turnId: "turn-2", command: "ls" });
  });

  test("starts a turn of Claude's own that begins right as the last turn ends", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    const [prompt] = await readPrompts(claude, 1);
    claude.emit(sdk(answer("msg-1", "started")));
    claude.emit(sdk(success([prompt?.uuid])));
    claude.emit(sdk(INIT));
    claude.emit(sdk(answer("msg-2", "the agent finished")));
    claude.emit(sdk(ownResult()));
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(completedTurns(sent)).toMatchObject([
      { id: "turn-1", items: [{ text: "started" }] },
      { id: "turn-2", items: [{ text: "the agent finished" }] },
    ]);
  });

  test("runs what the user sends during Claude's own turn after it", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);
    const prompts = claude.prompt()?.[Symbol.asyncIterator]();
    await prompts?.next();

    claude.emit(sdk(INIT));
    await until(() => startedTurns(sent).length === 2);
    turns.startTurn(turnStart(11, "next"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    claude.emit(sdk(answer("msg-2", "the agent finished")));
    claude.emit(sdk(ownResult()));
    const next = await prompts?.next();
    claude.emit(sdk(answer("msg-3", "hi")));
    claude.emit(sdk(success([next?.value?.uuid])));
    await until(() => completedTurnStatuses(sent).length === 3);

    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-3" });
    expect(next?.value?.message.content).toBe("next");
    expect(completedTurns(sent).slice(1)).toMatchObject([
      { id: "turn-2", items: [{ text: "the agent finished" }] },
      { id: "turn-3", items: [{ text: "hi" }] },
    ]);
  });

  test("stops Claude's own turn when the app interrupts it", async () => {
    const claude = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const { turns, sent } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);

    claude.emit(sdk(INIT));
    await until(() => startedTurns(sent).length === 2);
    turns.interruptTurn(interrupt(20, "turn-2"));
    await until(() => claude.interrupts() === 1);
    claude.emit(
      sdk(ownResult({ subtype: "error_during_execution", is_error: true })),
    );
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(responseTo(sent, 20)).toEqual({ id: 20, result: {} });
    expect(completedTurnStatuses(sent)).toEqual(["completed", "interrupted"]);
    expect(claude.closes()).toBe(0);
  });

  test("leaves a background task's report alone until Claude starts a turn for it", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);

    claude.emit(sdk(TASKS_RUNNING));
    claude.emit(
      sdk({ ...answer("msg-sub", "working"), parent_tool_use_id: "toolu-1" }),
    );
    claude.emit(
      sdk({
        type: "system",
        subtype: "task_notification",
        task_id: "task-1",
        status: "completed",
        output_file: "/tmp/task-1.output",
        summary: "done",
      }),
    );
    await until(() => claude.drained());
    await settle();

    expect(startedTurns(sent)).toHaveLength(1);
  });

  test("keeps Claude running past the idle time until its background tasks end", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, events } = await harness([claude], {
      idleSessionMs: 5,
    });

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    claude.emit(sdk(TASKS_RUNNING));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);
    await Bun.sleep(30);
    expect(claude.closes()).toBe(0);
    claude.emit(sdk({ ...TASKS_RUNNING, tasks: [] }));
    await until(() => claude.closes() === 1);

    expect(events).toContainEqual({
      event: "claude_turn",
      step: "idle_closed",
    });
  });

  test("closes Claude at the idle time when only ambient tasks run", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude], { idleSessionMs: 5 });

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    claude.emit(
      sdk({
        ...TASKS_RUNNING,
        tasks: [{ ...TASKS_RUNNING.tasks[0], ambient: true }],
      }),
    );
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    await until(() => claude.closes() === 1);
  });

  test("shows the rest of a turn Claude started on its own as no new turn when the app could not be shown it", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    let failing = false;
    const { turns, sent } = await harness([claude], {
      files: {
        createMarker: async (path) => {
          if (!failing) return createEmptyFile(path);
          failing = false;
          return diskFull(path);
        },
      },
    });
    await completeTurn(turns, sent, claude, 10);

    failing = true;
    claude.emit(sdk(INIT));
    await until(() => completedTurnStatuses(sent).length === 2);
    claude.emit(sdk(answer("msg-2", "the agent finished")));
    claude.emit(sdk(ownResult()));
    await until(() => claude.drained());
    await settle();
    claude.emit(sdk(INIT));
    claude.emit(sdk(answer("msg-3", "another report")));
    claude.emit(sdk(ownResult()));
    await until(() => completedTurnStatuses(sent).length === 3);

    expect(completedTurns(sent).slice(1)).toMatchObject([
      { id: "turn-2", status: "failed" },
      { id: "turn-3", items: [{ text: "another report" }] },
    ]);
  });

  test("resumes on a new Claude after the session failed while no turn ran", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const next = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([claude, next]);
    await completeTurn(turns, sent, claude, 10);

    claude.fail(new Error("Claude Code process exited with code 1"));
    await until(() => claude.closes() === 1);
    await completeTurn(turns, sent, next, 11);

    expect(settings[1]).toMatchObject({ resume: "se-1" });
    expect(completedTurnStatuses(sent)).toEqual(["completed", "completed"]);
  });
});

describe("approvals no turn could show", () => {
  test("holds a background agent's approval in a turn nobody typed that completes once the app answers", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, events } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);

    const decision = askTool(
      claude,
      "Bash",
      { command: "ls" },
      { agentID: "agent-1" },
    );
    const request = await appRequest(sent);
    await settle();
    expect(completedTurnStatuses(sent)).toEqual(["completed"]);
    turns.answerRequest({ id: request.id, result: ALLOWED });
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(await decision).toEqual({ behavior: "allow" });
    expect(request).toMatchObject({
      method: "item/tool/requestUserInput",
      params: { threadId: THREAD, turnId: "turn-2" },
    });
    expect(completedTurns(sent)[1]).toMatchObject({
      id: "turn-2",
      status: "completed",
      items: [],
    });
    const held = sent.slice(sent.findIndex(isTurnStarted("turn-2")));
    expect(held.filter((m) => m.method === "item/started")).toEqual([]);
    expect(events).toContainEqual({
      event: "claude_turn",
      step: "approval_turn",
    });
    expect(claude.interrupts()).toBe(0);
    expect(claude.closes()).toBe(0);
  });

  test("shows every approval that comes while the turn is open in it and ends the turn after the last answer", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);

    const first = agentAsks(claude, "tool-1");
    const second = agentAsks(claude, "tool-2");
    await until(() => askedRequests(sent).length === 2);
    const [firstRequest, secondRequest] = askedRequests(sent);
    turns.answerRequest({ id: firstRequest.id, result: ALLOWED });
    expect(await first).toEqual({ behavior: "allow" });
    const third = agentAsks(claude, "tool-3");
    await until(() => askedRequests(sent).length === 3);
    turns.answerRequest({ id: secondRequest.id, result: DENIED });
    expect((await second)?.behavior).toBe("deny");
    await settle();
    expect(completedTurnStatuses(sent)).toEqual(["completed"]);
    turns.answerRequest({ id: askedRequests(sent)[2].id, result: ALLOWED });
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(await third).toEqual({ behavior: "allow" });
    expect(startedTurns(sent)).toEqual(["turn-1", "turn-2"]);
    expect(askedRequests(sent).map((m) => m.params.turnId)).toEqual([
      "turn-2",
      "turn-2",
      "turn-2",
    ]);
    expect(completedTurnStatuses(sent)).toEqual(["completed", "completed"]);
  });

  test("asks in a turn the app started that is accepted but not yet shown rather than in a turn of its own", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const marking = { held: false };
    const gate = createGate();
    const { turns, sent } = await harness([claude], {
      files: {
        createMarker: async (path) => {
          if (marking.held) await gate.promise;
          return createEmptyFile(path);
        },
      },
    });
    await completeTurn(turns, sent, claude, 10);

    marking.held = true;
    turns.startTurn(turnStart(11, "next"), undefined);
    const decision = agentAsks(claude, "tool-1");
    await settle();
    expect(askedRequests(sent)).toEqual([]);
    gate.open();
    const request = await appRequest(sent);
    turns.answerRequest({ id: request.id, result: ALLOWED });
    expect(await decision).toEqual({ behavior: "allow" });
    claude.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(request.params.turnId).toBe("turn-2");
    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-2" });
    expect(startedTurns(sent)).toEqual(["turn-1", "turn-2"]);
  });

  test("shows a turn Claude starts while the approval waits as a turn of its own after the approval's", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);

    const decision = agentAsks(claude, "tool-1");
    const request = await appRequest(sent);
    claude.emit(sdk(INIT));
    claude.emit(sdk(answer("msg-2", "the agent finished")));
    claude.emit(sdk(ownResult()));
    await settle();
    expect(startedTurns(sent)).toEqual(["turn-1", "turn-2"]);
    turns.answerRequest({ id: request.id, result: ALLOWED });
    await until(() => completedTurnStatuses(sent).length === 3);

    expect(await decision).toEqual({ behavior: "allow" });
    expect(completedTurns(sent).slice(1)).toMatchObject([
      { id: "turn-2", status: "completed", items: [] },
      {
        id: "turn-3",
        status: "completed",
        items: [{ type: "agentMessage", text: "the agent finished" }],
      },
    ]);
    expect(claude.closes()).toBe(0);
  });

  test("runs what the user sends while the approval waits after it, with the turn Claude started ahead of its reply", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);
    const prompts = claude.prompt()?.[Symbol.asyncIterator]();
    await prompts?.next();

    const decision = agentAsks(claude, "tool-1");
    const request = await appRequest(sent);
    claude.emit(sdk(INIT));
    claude.emit(sdk(answer("msg-2", "the agent finished")));
    turns.startTurn(turnStart(11, "next"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    turns.answerRequest({ id: request.id, result: ALLOWED });
    claude.emit(sdk(ownResult()));
    const next = await prompts?.next();
    claude.emit(sdk(answer("msg-3", "hi")));
    claude.emit(sdk(success([next?.value?.uuid])));
    await until(() => completedTurnStatuses(sent).length === 3);

    expect(await decision).toEqual({ behavior: "allow" });
    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-3" });
    expect(next?.value?.message.content).toBe("next");
    expect(completedTurns(sent).slice(1)).toMatchObject([
      { id: "turn-2", status: "completed" },
      { id: "turn-3", status: "completed", items: [{ text: "hi" }] },
    ]);
    expect(claude.closes()).toBe(0);
  });

  test("declines the approvals the turn holds when the app interrupts it and ends it as interrupted without stopping Claude", async () => {
    const claude = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const { turns, sent } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);

    const first = agentAsks(claude, "tool-1");
    const second = agentAsks(claude, "tool-2");
    await until(() => askedRequests(sent).length === 2);
    turns.interruptTurn(interrupt(20, "turn-2"));

    expect((await first)?.behavior).toBe("deny");
    expect((await second)?.behavior).toBe("deny");
    await until(() => completedTurnStatuses(sent).length === 2);
    expect(responseTo(sent, 20)).toEqual({ id: 20, result: {} });
    expect(completedTurnStatuses(sent)).toEqual(["completed", "interrupted"]);
    expect(resolvedRequests(sent)).toEqual(
      askedRequests(sent).map((m) => m.id),
    );
    expect(claude.interrupts()).toBe(0);
    expect(claude.closes()).toBe(0);
  });

  test("refuses a steer into the turn holding approvals", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);

    agentAsks(claude, "tool-1");
    await appRequest(sent);
    turns.steerTurn(steer(30, "turn-2", "also this"));

    expect(responseTo(sent, 30)).toEqual(REFUSED(30));
  });

  test("stops waiting for an approval Claude aborts and ends the turn when it was the last", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);
    const aborts = [new AbortController(), new AbortController()];

    const first = agentAsks(claude, "tool-1", aborts[0]?.signal);
    const second = agentAsks(claude, "tool-2", aborts[1]?.signal);
    await until(() => askedRequests(sent).length === 2);
    aborts[0]?.abort();
    expect((await first)?.behavior).toBe("deny");
    await settle();
    expect(completedTurnStatuses(sent)).toEqual(["completed"]);
    aborts[1]?.abort();
    expect((await second)?.behavior).toBe("deny");
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(completedTurnStatuses(sent)).toEqual(["completed", "completed"]);
    expect(resolvedRequests(sent)).toEqual(
      askedRequests(sent).map((m) => m.id),
    );
  });

  test.each<{
    name: string;
    end: (
      started: Awaited<ReturnType<typeof harness>>,
      claude: ReturnType<typeof fakeClaude>,
    ) => void;
  }>([
    {
      name: "Claude stops",
      end: (_started, claude) => claude.fail(new Error("socket closed")),
    },
    {
      name: "its session is dropped",
      end: ({ runtime, sessionLinks: [link] }) => {
        if (link !== undefined) runtime.dropSession(THREAD, link);
      },
    },
    { name: "the bridge closes", end: ({ turns }) => turns.closeAll() },
  ])("declines the approvals the turn holds and ends it when $name", async ({
    end,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const started = await harness([claude]);
    const { turns, sent } = started;
    await completeTurn(turns, sent, claude, 10);

    const first = agentAsks(claude, "tool-1");
    const second = agentAsks(claude, "tool-2");
    await until(() => askedRequests(sent).length === 2);
    end(started, claude);

    expect((await first)?.behavior).toBe("deny");
    expect((await second)?.behavior).toBe("deny");
    await until(() => completedTurnStatuses(sent).length === 2);
    expect(resolvedRequests(sent)).toEqual(
      askedRequests(sent).map((m) => m.id),
    );
    await until(() => claude.closes() > 0);
  });

  test.each<{
    name: string;
    options: Parameters<typeof harness>[1];
    before: (turns: Turns) => void;
  }>([
    {
      name: "the app cannot be shown a turn of Claude's own",
      options: { ownTurnsShown: false },
      before: () => {},
    },
    {
      name: "the bridge has closed",
      options: {},
      before: (turns) => turns.closeAll(),
    },
  ])("declines an approval without opening a turn when $name", async ({
    options,
    before,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude], options);
    await completeTurn(turns, sent, claude, 10);
    before(turns);

    const decision = await agentAsks(claude, "tool-1");

    expect(decision).toEqual({
      behavior: "deny",
      message: "no Claude turn is running to ask the app for approval",
    });
    expect(askedRequests(sent)).toEqual([]);
    expect(startedTurns(sent)).toEqual(["turn-1"]);
  });

  test("shows a background agent's call declined in the turn holding it as declined in the agent's thread", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, subagents } = await harness([claude]);
    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    claude.emit(sdk(taskStarted("toolu-agent", 1)));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);
    claude.emit(
      sdk({ ...bashCall("toolu-ls"), parent_tool_use_id: "toolu-agent" }),
    );
    await until(() => claude.drained());

    const decision = agentAsks(claude, "toolu-ls");
    const request = await appRequest(sent);
    turns.answerRequest({ id: request.id, result: DENIED });
    expect((await decision)?.behavior).toBe("deny");
    await until(() => completedTurnStatuses(sent).length === 2);
    claude.emit(
      sdk({ ...toolError("toolu-ls"), parent_tool_use_id: "toolu-agent" }),
    );
    await until(() =>
      completedItems(sent).some((item) => item.type === "commandExecution"),
    );

    const [child] = subagents.childrenOf(THREAD);
    expect(
      sent.find(
        (m) =>
          m.method === "item/completed" &&
          m.params.item.type === "commandExecution",
      )?.params,
    ).toMatchObject({ threadId: child?.id, item: { status: "declined" } });
  });
});

describe("turn/steer", () => {
  test("answers with the turn id, passes the steer to Claude and shows it in the turn", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.steerTurn(steer(30, "turn-1", "also this"));
    const [prompt, steered] = await readPrompts(claude, 2);
    claude.emit(sdk(answer("msg-1", "ok")));
    claude.emit(sdk(success([prompt?.uuid, steered?.uuid])));
    await until(() => turnCompleted(sent) !== undefined);

    expect(responseTo(sent, 30)).toEqual({
      id: 30,
      result: { turnId: "turn-1" },
    });
    expect(steered?.message.content).toBe("also this");
    expect(
      completedItems(sent).filter((item) => item.type === "userMessage"),
    ).toMatchObject([
      { content: [{ text: "hello" }] },
      { content: [{ text: "also this" }] },
    ]);
    expect(completedTurnStatuses(sent)).toEqual(["completed"]);
  });

  test.each([
    { name: "queued when Claude ended its turn", queued: 1 },
    { name: "sent after Claude wrote its result", queued: 0 },
  ])("keeps the turn open through the Claude turn that runs a steer $name", async ({
    queued,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.steerTurn(steer(30, "turn-1", "also this"));
    const [prompt, steered] = await readPrompts(claude, 2);
    claude.emit(sdk(answer("msg-1", "first")));
    claude.emit(sdk(success([prompt?.uuid], queued)));
    await until(() => claude.drained());
    expect(completedTurnStatuses(sent)).toEqual([]);
    claude.emit(sdk(answer("msg-2", "second")));
    claude.emit(sdk(success([steered?.uuid])));
    await until(() => turnCompleted(sent) !== undefined);

    expect(completedTurnStatuses(sent)).toEqual(["completed"]);
    expect(turnCompleted(sent).items).toMatchObject([{ text: "second" }]);
    expect(claude.closes()).toBe(0);
  });

  // user_message_uuids holds at most 64 sends and user_message_uuid only the last, so a steer Claude took can go unnamed.
  test.each<{ name: string; taken: (uuid: string | undefined) => object }>([
    { name: "no uuids", taken: () => ({}) },
    {
      name: "a full list",
      taken: (uuid) => ({
        user_message_uuids: [
          uuid,
          ...Array.from({ length: 63 }, (_, i) => `uuid-${i}`),
        ],
      }),
    },
    {
      name: "only the last uuid",
      taken: (uuid) => ({ user_message_uuid: uuid }),
    },
  ])("fails the turn asking for the steer again and resumes on a new session when nothing is queued and the result has $name", async ({
    taken,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const next = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([claude, next]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.steerTurn(steer(30, "turn-1", "also this"));
    const [prompt] = await readPrompts(claude, 2);
    claude.emit(sdk(answer("msg-1", "ok")));
    claude.emit(
      sdk(
        result({
          subtype: "success",
          is_error: false,
          result: "done",
          queued_turn_count: 0,
          ...taken(prompt?.uuid),
        }),
      ),
    );
    await until(() => turnCompleted(sent) !== undefined);
    await completeTurn(turns, sent, next, 11);

    expect(turnCompleted(sent)).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("send it again") },
    });
    expect(completedTurnStatuses(sent)).toEqual(["failed", "completed"]);
    expect(claude.closes()).toBe(1);
    expect(settings[1]).toMatchObject({ resume: "se-1" });
  });

  test("refuses a steer beyond what one turn's result can name", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    // Steers are sent one after another into the same turn, so this loop is a scenario rather than a table.
    for (let id = 100; id < 162; id += 1) {
      turns.steerTurn(steer(id, "turn-1", `steer ${id}`));
    }
    turns.steerTurn(steer(162, "turn-1", "one too many"));

    expect(responseTo(sent, 161)?.result).toEqual({ turnId: "turn-1" });
    expect(responseTo(sent, 162)).toEqual(REFUSED(162));
  });

  test("fails the turn and closes Claude when the Claude turn before a queued steer fails", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.steerTurn(steer(30, "turn-1", "also this"));
    const [prompt] = await readPrompts(claude, 2);
    claude.emit(
      sdk(
        result({
          subtype: "success",
          is_error: true,
          result: "rate limited",
          user_message_uuids: [prompt?.uuid],
          queued_turn_count: 1,
        }),
      ),
    );
    await until(() => turnCompleted(sent) !== undefined);

    expect(turnCompleted(sent)).toMatchObject({
      status: "failed",
      error: { message: "rate limited" },
    });
    expect(claude.closes()).toBe(1);
  });

  test("ends a turn waiting on a queued steer as interrupted when stopped", async () => {
    const claude = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.steerTurn(steer(30, "turn-1", "also this"));
    const [prompt, steered] = await readPrompts(claude, 2);
    claude.emit(sdk(success([prompt?.uuid], 1)));
    await until(() => claude.drained());
    expect(completedTurnStatuses(sent)).toEqual([]);
    turns.interruptTurn(interrupt(20, "turn-1"));
    await until(() => claude.interrupts() === 1);
    claude.emit(
      sdk(
        result({
          subtype: "error_during_execution",
          is_error: true,
          user_message_uuids: [steered?.uuid],
        }),
      ),
    );
    await until(() => turnCompleted(sent) !== undefined);

    expect(completedTurnStatuses(sent)).toEqual(["interrupted"]);
    expect(claude.closes()).toBe(0);
  });

  test("sends a steer that arrives while Claude is starting after the turn's prompt", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    let start = () => {};
    const beforeStart = new Promise<void>((resolve) => {
      start = resolve;
    });
    const { turns, sent } = await harness([claude], { beforeStart });

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    turns.steerTurn(steer(30, "turn-1", "also this"));
    start();
    await until(() => claude.started());
    const prompts = await readPrompts(claude, 2);

    expect(responseTo(sent, 30)?.result).toEqual({ turnId: "turn-1" });
    expect(prompts.map((message) => message.message.content)).toEqual([
      "hello",
      "also this",
    ]);
  });

  test.each([
    { name: "another turn id", request: steer(30, "turn-9", "also this") },
    {
      name: "non-text input",
      request: {
        ...steer(30, "turn-1", "also this"),
        params: {
          threadId: THREAD,
          expectedTurnId: "turn-1",
          input: [{ type: "image" }],
        },
      },
    },
  ])("refuses a steer with $name and leaves the turn running", async ({
    request,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.steerTurn(request);
    const [prompt] = await readPrompts(claude, 1);
    claude.emit(sdk(success([prompt?.uuid])));
    await until(() => turnCompleted(sent) !== undefined);

    expect(responseTo(sent, 30)).toEqual(REFUSED(30));
    expect(prompt?.message.content).toBe("hello");
    expect(completedTurnStatuses(sent)).toEqual(["completed"]);
  });

  test("refuses a steer once the turn is stopping", async () => {
    const claude = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.interruptTurn(interrupt(20, "turn-1"));
    turns.steerTurn(steer(30, "turn-1", "also this"));

    expect(responseTo(sent, 20)).toEqual({ id: 20, result: {} });
    expect(responseTo(sent, 30)).toEqual(REFUSED(30));
  });
});

describe("skill links in Claude input", () => {
  test("attaches the linked SKILL.md after the typed text Claude reads while the turn shows the input as typed", async () => {
    const skill = await writeSkill("demo", "---\nname: demo\n---\nDo it.\n");
    const typed = `[$demo](${skill}) go`;
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, typed), undefined);
    await until(() => claude.started());
    const [prompt] = await readPrompts(claude, 1);
    claude.emit(sdk(answer("msg-1", "done")));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    expect(prompt?.message.content).toEqual([
      { type: "text", text: typed },
      {
        type: "text",
        text: `<skill>\n<name>demo</name>\n<path>${skill}</path>\n---\nname: demo\n---\nDo it.\n</skill>`,
      },
    ]);
    expect(
      completedItems(sent).filter((item) => item.type === "userMessage"),
    ).toMatchObject([{ content: [{ text: typed }] }]);
  });

  // A steer is answered before any file could be read, so its link reaches Claude as typed.
  test("passes a steer's skill link as typed", async () => {
    const skill = await writeSkill("demo", "Do it.\n");
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.steerTurn(steer(30, "turn-1", `[$demo](${skill})`));
    const [, steered] = await readPrompts(claude, 2);

    expect(steered?.message.content).toBe(`[$demo](${skill})`);
  });

  test("sends a skill the Claude session already holds as its link alone and logs it", async () => {
    const skill = await writeSkill("demo", "Do it.\n");
    const typed = `[$demo](${skill}) go`;
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, events } = await harness([claude]);

    await skillTurn(turns, sent, claude, 10, typed);
    await skillTurn(turns, sent, claude, 11, typed);
    const [first, second] = await readPrompts(claude, 2);

    expect(Array.isArray(first?.message.content)).toBe(true);
    expect(second?.message.content).toBe(typed);
    expect(events).toContainEqual({
      event: "claude_turn",
      step: "skill_link_only",
    });
  });

  test("attaches a skill again when its SKILL.md changed since it was attached", async () => {
    const skill = await writeSkill("demo", "Do it.\n");
    const typed = `[$demo](${skill}) go`;
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    await skillTurn(turns, sent, claude, 10, typed);
    await writeSkill("demo", "Do it differently.\n");
    await skillTurn(turns, sent, claude, 11, typed);
    const [, second] = await readPrompts(claude, 2);

    expect(second?.message.content).toMatchObject([
      { text: typed },
      { text: expect.stringContaining("Do it differently.") },
    ]);
  });

  test.each([
    {
      name: "compacts the conversation",
      message: { type: "system", subtype: "compact_boundary" },
    },
    {
      name: "resets the conversation",
      message: { type: "conversation_reset", trigger: "clear" },
    },
  ])("attaches a skill again after Claude $name", async ({ message }) => {
    const skill = await writeSkill("demo", "Do it.\n");
    const typed = `[$demo](${skill}) go`;
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    await skillTurn(turns, sent, claude, 10, typed, [sdk(message)]);
    await skillTurn(turns, sent, claude, 11, typed);
    const [, second] = await readPrompts(claude, 2);

    expect(Array.isArray(second?.message.content)).toBe(true);
  });

  test("attaches a skill again on a new Claude session", async () => {
    const skill = await writeSkill("demo", "Do it.\n");
    const typed = `[$demo](${skill}) go`;
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([first, second]);

    await skillTurn(turns, sent, first, 10, typed);
    turns.changeModel(THREAD, OTHER_MODEL);
    await skillTurn(turns, sent, second, 11, typed);

    expect(Array.isArray((await firstPromptMessage(second))?.content)).toBe(
      true,
    );
  });

  test("sends the link alone and logs it when the SKILL.md cannot be read", async () => {
    const typed = `[$gone](${join(dir, "gone", "SKILL.md")}) go`;
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, events } = await harness([claude]);

    turns.startTurn(turnStart(10, typed), undefined);
    await until(() => claude.started());

    expect(await firstPrompt(claude.prompt())).toBe(typed);
    expect(events).toContainEqual({
      event: "claude_turn",
      step: "skill_unreadable",
    });
  });
});

describe("thread/compact/start on a Claude thread", () => {
  test("answers at once with an empty result, sends /compact and shows the compaction as the turn's only item", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, events } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);
    const before = sent.length;

    turns.compactThread(compactStart(20));
    await until(() => startedTurns(sent).length === 2);
    expect((await promptsUntil(claude, 2))[1]).toBe("/compact");
    claude.emit(sdk(compactBoundary("manual")));
    claude.emit(sdk(compacted()));
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(sent.slice(before).map((m) => m.method ?? "response")).toEqual([
      "response",
      "thread/status/changed",
      "turn/started",
      "item/started",
      "item/completed",
      "thread/compacted",
      "thread/tokenUsage/updated",
      "thread/status/changed",
      "turn/completed",
    ]);
    expect(responseTo(sent, 20)?.result).toEqual({});
    expect(completedItems(sent.slice(before))).toEqual([
      { type: "contextCompaction", id: "turn-2-item-1" },
    ]);
    expect(completedTurnStatuses(sent)).toEqual(["completed", "completed"]);
    expect(
      events.flatMap((event) =>
        event.step === "metrics" ? [event.compaction] : [],
      ),
    ).toEqual([false, true]);
  });

  test("waits behind a running turn and then compacts the same Claude session", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    turns.compactThread(compactStart(11));
    await settle();
    expect(responseTo(sent, 11)?.result).toEqual({});
    expect(startedTurns(sent)).toEqual(["turn-1"]);
    claude.emit(sdk(answer("msg-1", "hi")));
    claude.emit(sdk(success()));
    await until(() => startedTurns(sent).length === 2);
    claude.emit(sdk(compactBoundary("manual")));
    claude.emit(sdk(compacted()));
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(await promptsUntil(claude, 2)).toEqual(["hello", "/compact"]);
    expect(completedTurnStatuses(sent)).toEqual(["completed", "completed"]);
    expect(settings).toHaveLength(1);
  });

  test.each([
    {
      name: "a thread that never ran",
      prepare: async () => {
        const claude = fakeClaude(SUBSCRIPTION);
        return { claude, ...(await harness([claude])) };
      },
    },
    {
      name: "a thread whose Claude conversation was found lost",
      prepare: async () => {
        const first = fakeClaude(SUBSCRIPTION);
        const before = await harness([first]);
        await completeTurn(before.turns, before.sent, first, 10);
        await until(() => before.store.get(THREAD)?.runState === "idle");
        const claude = fakeClaude(SUBSCRIPTION);
        const after = await harness([claude], { missingSessions: ["se-1"] });
        after.turns.startTurn(turnStart(11, "hello"), undefined);
        await until(() => after.store.get(THREAD)?.sessionId === null);
        await until(() => after.store.get(THREAD)?.runState === "idle");
        return { claude, ...after };
      },
    },
  ])("refuses to compact $name without starting Claude", async ({
    prepare,
  }) => {
    const { claude, turns, sent } = await prepare();

    turns.compactThread(compactStart(20));
    await settle();

    expect(responseTo(sent, 20)?.error.message).toBe(
      "there is no Claude conversation to compact yet",
    );
    expect(claude.started()).toBe(false);
  });

  test("refuses a steer into a running compaction", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);
    turns.compactThread(compactStart(20));
    await until(() => startedTurns(sent).length === 2);

    turns.steerTurn(steer(21, "turn-2", "more"));

    expect(responseTo(sent, 21)).toEqual(REFUSED(21));
    expect((await promptsUntil(claude, 2))[1]).toBe("/compact");
    expect(
      completedItems(sent).filter((item) => item.type === "userMessage"),
    ).toHaveLength(1);
  });

  test("fails a compaction on a thread whose last turn has an unknown outcome without starting Claude", async () => {
    const second = fakeClaude(SUBSCRIPTION);
    const after = await restartedWithUnknownOutcome([second]);

    after.turns.compactThread(compactStart(20));
    await until(() => turnCompleted(after.sent) !== undefined);

    expect(responseTo(after.sent, 20)?.result).toEqual({});
    expect(turnCompleted(after.sent)).toMatchObject({
      status: "failed",
      error: { message: OUTCOME_UNKNOWN },
    });
    expect(second.started()).toBe(false);
  });
});

describe("thread tools", () => {
  test("give each Claude session its own thread tool server and allowed tools", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings, links } = await harness([first, second]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => first.started());
    first.fail(new Error("socket closed"));
    await until(() => turnCompleted(sent) !== undefined);
    await completeTurn(turns, sent, second, 11);

    expect(links).toEqual([THREAD, THREAD]);
    expect(settings[0]?.allowedTools).toEqual(ALLOWED_TOOLS);
    expect(Object.keys(settings[0]?.mcpServers ?? {})).toEqual(["codex_link"]);
    expect(settings[1]?.mcpServers?.codex_link).not.toBe(
      settings[0]?.mcpServers?.codex_link,
    );
  });

  test("stop taking writes when the turn is stopped", async () => {
    const claude = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const { turns, gates } = await harness([claude]);
    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    expect(gates).toEqual(["accept"]);

    turns.interruptTurn(interrupt(20, "turn-1"));

    expect(gates).toEqual(["accept", "stop"]);
  });

  test("stop taking writes when a turn finishes and take them again for the next turn", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store, gates } = await harness([claude]);

    await completeTurn(turns, sent, claude, 10);
    await until(() => store.get(THREAD)?.runState === "idle");
    expect(gates).toEqual(["accept", "stop"]);
    await completeTurn(turns, sent, claude, 11);
    await until(() => gates.length === 4);

    expect(gates).toEqual(["accept", "stop", "accept", "stop"]);
  });
});

describe("idle Claude sessions", () => {
  test("close after the idle time and resume the conversation on the next turn", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings, events } = await harness([first, second], {
      idleSessionMs: 5,
    });

    await completeTurn(turns, sent, first, 10);
    await until(() => first.closes() === 1);
    await completeTurn(turns, sent, second, 11);

    expect(events).toContainEqual({
      event: "claude_turn",
      step: "idle_closed",
    });
    expect(settings[1]).toMatchObject({ resume: "se-1" });
    expect(completedTurnStatuses(sent)).toEqual(["completed", "completed"]);
  });

  test("stay open for a turn that starts before the idle time ends", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store, settings } = await harness([claude], {
      idleSessionMs: 40,
    });
    await completeTurn(turns, sent, claude, 10);
    await until(() => store.get(THREAD)?.runState === "idle");
    await Bun.sleep(5);

    turns.startTurn(turnStart(11, "again"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    await Bun.sleep(60);
    claude.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(claude.closes()).toBe(0);
    expect(settings).toHaveLength(1);
    expect(completedTurnStatuses(sent)).toEqual(["completed", "completed"]);
  });

  test("stay open for a turn that waited behind the one that ended", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude], { idleSessionMs: 5 });

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.startTurn(turnStart(11, "again"), undefined);
    claude.emit(sdk(success()));
    await until(() => responseTo(sent, 11) !== undefined);
    await settle();

    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-2" });
    expect(claude.closes()).toBe(0);
  });

  test("stay open when Claude never reported a session id to resume", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([claude], {
      idleSessionMs: 5,
    });

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    claude.emit(sdk({ ...success(), session_id: undefined }));
    await until(() => turnCompleted(sent) !== undefined);
    await settle();
    await completeTurn(turns, sent, claude, 11);

    expect(claude.closes()).toBe(0);
    expect(settings).toHaveLength(1);
    expect(completedTurnStatuses(sent)).toEqual(["completed", "completed"]);
  });
});

const startedTurn = async (claude: ReturnType<typeof fakeClaude>) => {
  const started = await harness([claude]);
  started.turns.startTurn(turnStart(10, "hello"), undefined);
  await until(() => claude.started());
  return started;
};

type Turns = ReturnType<typeof createTurnController>;

const agentAsks = (
  claude: ReturnType<typeof fakeClaude>,
  toolUseID: string,
  signal?: AbortSignal,
) =>
  askTool(
    claude,
    "Bash",
    { command: "ls" },
    {
      agentID: "agent-1",
      toolUseID,
      ...(signal === undefined ? {} : { signal }),
    },
  );

const askedRequests = (sent: Sent[]) =>
  sent.filter((m) => typeof m.id === "string" && m.id.startsWith("harnexus-"));

const ALLOWED = { answers: { approval: { answers: ["Allow"] } } };

const DENIED = { answers: { approval: { answers: ["Deny"] } } };

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

const skillTurn = async (
  turns: ReturnType<typeof createTurnController>,
  sent: Sent[],
  claude: ReturnType<typeof fakeClaude>,
  id: number,
  text: string,
  before: SDKMessage[] = [],
) => {
  const done = completedTurnStatuses(sent).length;
  turns.startTurn(turnStart(id, text), undefined);
  await until(() => responseTo(sent, id) !== undefined);
  await until(() => claude.started());
  await until(() => claude.drained());
  for (const message of before) claude.emit(message);
  claude.emit(sdk(success()));
  await until(() => completedTurnStatuses(sent).length > done);
};

const firstPromptMessage = async (claude: ReturnType<typeof fakeClaude>) => {
  const [prompt] = await readPrompts(claude, 1);
  return prompt?.message;
};

const compactStart = (id: number) => ({
  id,
  params: { threadId: THREAD } as Record<string, unknown>,
});

const steer = (id: number, turnId: string, text: string) => ({
  id,
  params: {
    threadId: THREAD,
    expectedTurnId: turnId,
    input: [{ type: "text", text, text_elements: [] }],
  } as Record<string, unknown>,
});

const INIT = { type: "system", subtype: "init" };

const TASKS_RUNNING = {
  type: "system",
  subtype: "background_tasks_changed",
  tasks: [{ task_id: "task-1", task_type: "local_agent", description: "x" }],
};

const isTurnStarted = (turnId: string) => (message: Sent) =>
  message.method === "turn/started" && message.params.turn.id === turnId;

// The result of a turn Claude started when a background task reported back, which names no send unless one joined it.
const ownResult = (fields: object = {}) =>
  result({
    subtype: "success",
    is_error: false,
    result: "done",
    origin: { kind: "task-notification" },
    ...fields,
  });

const writeSkill = async (name: string, body: string) => {
  const path = join(dir, "skills", name, "SKILL.md");
  await mkdir(join(dir, "skills", name), { recursive: true });
  await writeFile(path, body);
  return path;
};

// Reads only as many prompts as were sent, since a read past them waits for the next send.
const readPrompts = async (
  claude: ReturnType<typeof fakeClaude>,
  count: number,
) => {
  const prompt = claude.prompt();
  if (prompt === null) return expect.unreachable("Claude never started");
  const iterator = prompt[Symbol.asyncIterator]();
  const read: SDKUserMessage[] = [];
  while (read.length < count) {
    const next = await iterator.next();
    if (next.done === true) break;
    read.push(next.value);
  }
  return read;
};

const bashCall = (toolUseId: string) => ({
  type: "assistant",
  message: {
    id: "msg-tool",
    content: [
      {
        type: "tool_use",
        id: toolUseId,
        name: "Bash",
        input: { command: "rm -rf build" },
      },
    ],
    stop_reason: "tool_use",
  },
  parent_tool_use_id: null,
});

const toolError = (toolUseId: string) => ({
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: "denied",
        is_error: true,
      },
    ],
  },
  parent_tool_use_id: null,
});

const compactBoundary = (trigger: "manual" | "auto") => ({
  type: "system",
  subtype: "compact_boundary",
  compact_metadata: { trigger, pre_tokens: 20_000, post_tokens: 2_000 },
});

// The CLI ends /compact with an empty successful result.
const compacted = () =>
  result({ subtype: "success", is_error: false, result: "" });

const taskStarted = (toolUseId: string, depth: number) => ({
  type: "system",
  subtype: "task_started",
  task_id: `task-${toolUseId}`,
  tool_use_id: toolUseId,
  description: "read the README",
  subagent_type: "Explore",
  task_type: "local_agent",
  spawn_depth: depth,
});

const taskNotification = (toolUseId: string) => ({
  type: "system",
  subtype: "task_notification",
  task_id: `task-${toolUseId}`,
  tool_use_id: toolUseId,
  status: "completed",
  output_file: "/fixture/task.output",
  summary: "done",
});

// Each subagent activity item the app got, once at its completion, and each status change of a subagent's thread.
const subagentEvents = (sent: Sent[]) =>
  sent.flatMap((message) => {
    if (
      message.method === "item/completed" &&
      message.params.item.type === "subAgentActivity"
    ) {
      const { params } = message;
      return [
        `${params.threadId} ${params.turnId} ${params.item.kind} ${params.item.agentThreadId}`,
      ];
    }
    if (
      message.method === "thread/status/changed" &&
      message.params.threadId !== THREAD
    ) {
      return [`${message.params.threadId} ${message.params.status.type}`];
    }
    return [];
  });
