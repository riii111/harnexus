import { describe, expect, test } from "bun:test";
import type {
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import { fakeClaude } from "../../infra/claude/testing/fake-claude.ts";
import { createEmptyFile } from "../../runtime/fs.boundary.ts";
import {
  answer,
  appRequest,
  askTool,
  completedItems,
  completedTurnStatuses,
  completedTurns,
  completeTurn,
  createGate,
  firstPrompt,
  harness,
  interrupt,
  MODEL,
  REFUSED,
  readPrompts,
  resolvedRequests,
  responseTo,
  type Sent,
  SUBSCRIPTION,
  sdk,
  settle,
  startedTurns,
  success,
  THREAD,
  turnCompleted,
  turnStart,
  until,
  useTempDir,
} from "../testing/harness.ts";
import {
  ALLOWED,
  type FakeClaude,
  INIT,
  isTurnStarted,
  ownResult,
  steer,
  type Turns,
  taskStarted,
} from "./testing/runtime-fixtures.ts";

useTempDir();

describe("tool approval", () => {
  test("asks the app about the tool's item with Claude's reason and allows what it accepts", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await startedTurn(claude);

    const decision = askTool(
      claude,
      "Bash",
      { command: "rm -rf build" },
      { decisionReason: "An ask rule requires approval" },
    );
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
        reason: "An ask rule requires approval",
      },
    });
    expect(resolvedRequests(sent)).toEqual(["harnexus-1"]);
  });

  const suggestedRule: PermissionUpdate = {
    type: "addRules",
    rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
    behavior: "allow",
    destination: "localSettings",
  };

  test.each<{
    name: string;
    options: Parameters<typeof askTool>[3];
    proposed: string[] | undefined;
    expected: PermissionResult;
  }>([
    {
      name: "with the rule Claude suggests saved",
      options: { suggestions: [suggestedRule] },
      proposed: ["npm", "test"],
      expected: {
        behavior: "allow",
        updatedPermissions: [
          { ...suggestedRule, destination: "projectSettings" },
        ],
      },
    },
    {
      name: "without a rule when the SDK forbids saving",
      options: { suggestions: [suggestedRule], suppressAlwaysAllowRule: true },
      proposed: undefined,
      expected: { behavior: "allow" },
    },
  ])("answers the app's always allow of a command $name", async ({
    options,
    proposed,
    expected,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await startedTurn(claude);

    const decision = askTool(claude, "Bash", { command: "npm test" }, options);
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

    expect(request.params.proposedExecpolicyAmendment).toEqual(proposed);
    expect(await decision).toEqual(expected);
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

  test("returns the app's answer to Claude's question through the SDK permission callback", async () => {
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
});

describe("permission mode", () => {
  test("uses manual approvals when explicitly configured", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns } = await harness([claude], { permissionMode: "default" });
    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.modes().length === 1);

    expect(claude.options().permissionMode).toBe("default");
    expect(claude.modes()).toEqual(["default"]);
  });

  test("keeps auto mode when a plan is approved and the next turn reuses Claude", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, threads, sent } = await harness([claude]);
    threads.selectMode(THREAD, "plan");
    turns.startTurn(turnStart(10, "plan this"), undefined);
    await until(() => claude.modes().length === 1);
    expect(claude.options().permissionMode).toBe("plan");
    expect(claude.modes()).toEqual(["plan"]);

    const decision = askTool(claude, "ExitPlanMode", { plan: "Run tests" });
    const request = await appRequest(sent);
    turns.answerRequest({
      id: request.id,
      result: { answers: { plan: { answers: ["Approve"] } } },
    });
    expect(await decision).toEqual({
      behavior: "allow",
      updatedPermissions: [
        { type: "setMode", mode: "auto", destination: "session" },
      ],
    });
    const [prompt] = await readPrompts(claude, 1);
    claude.emit(sdk(success([prompt?.uuid])));
    await until(() => turnCompleted(sent) !== undefined);

    threads.selectMode(THREAD, "default");
    await completeTurn(turns, sent, claude, 11);
    expect(claude.modes()).toEqual(["plan", "auto"]);
  });

  test("fails without sending a prompt when Claude rejects auto mode", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      permissionModeError: new Error("auto mode unavailable"),
    });
    const { turns, sent } = await harness([claude], { permissionMode: "auto" });
    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => turnCompleted(sent) !== undefined);

    expect(turnCompleted(sent)).toMatchObject({
      status: "failed",
      error: { message: "cannot switch Claude to the auto permission mode" },
    });
    expect(claude.closes()).toBe(1);
    expect(await firstPrompt(claude.prompt())).toBeNull();
  });

  test.each([
    { name: "plan", mode: "plan", expected: "plan" },
    { name: "default", mode: "default", expected: "auto" },
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

  test("declines the approvals when Claude's stream ends with a turn the user sent queued, and runs that turn on a new Claude", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const next = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([claude, next]);
    await completeTurn(turns, sent, claude, 10);

    const decision = agentAsks(claude, "tool-1");
    await appRequest(sent);
    turns.startTurn(turnStart(11, "next"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    claude.emit(sdk(BACKGROUND_AGENT_SPOKE));
    claude.end();
    expect((await decision)?.behavior).toBe("deny");
    await until(() => next.prompted());
    next.emit(sdk(answer("msg-3", "hi")));
    next.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 3);

    expect(completedTurns(sent).slice(1)).toMatchObject([
      { id: "turn-2", status: "failed" },
      { id: "turn-3", status: "completed", items: [{ text: "hi" }] },
    ]);
    expect(settings[1]).toMatchObject({ resume: "se-1" });
  });

  test("keeps an agent's thread live after Claude starts a turn during the wait, and shows that turn after", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, request, decision, childItems } =
      await agentThreadWithApprovalWaiting(claude);
    await claudeRunsAgentToolInOwnTurn(claude, sent, childItems);
    turns.answerRequest({ id: request.id, result: ALLOWED });
    await until(() => completedTurnStatuses(sent).length === 3);
    await settle();

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
    expectAgentToolShownOnce(childItems);
  });

  test("keeps an agent's thread live after Claude starts a turn during the wait with a turn the user sent queued, and answers that turn after", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, prompts, request, decision, childItems } =
      await agentThreadWithApprovalWaiting(claude);
    turns.startTurn(turnStart(11, "next"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    await claudeRunsAgentToolInOwnTurn(claude, sent, childItems);
    turns.answerRequest({ id: request.id, result: ALLOWED });
    const next = await prompts?.next();
    claude.emit(sdk(answer("msg-3", "hi")));
    claude.emit(sdk(success([next?.value?.uuid])));
    await until(() => completedTurnStatuses(sent).length === 3);
    await settle();

    expect(await decision).toEqual({ behavior: "allow" });
    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-3" });
    expect(next?.value?.message.content).toBe("next");
    expect(completedTurns(sent).slice(1)).toMatchObject([
      { id: "turn-2", status: "completed", items: [] },
      { id: "turn-3", status: "completed", items: [{ text: "hi" }] },
    ]);
    expect(claude.closes()).toBe(0);
    expectAgentToolShownOnce(childItems);
  });

  test.each<{
    name: string;
    stop: (claude: ReturnType<typeof fakeClaude>) => void;
  }>([
    { name: "ends", stop: (claude) => claude.end() },
    {
      name: "fails",
      stop: (claude) => claude.fail(new Error("socket closed")),
    },
  ])("shows what Claude said during the wait to the turn the user queued when Claude's stream $name, and fails that turn", async ({
    stop,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const next = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude, next]);
    await completeTurn(turns, sent, claude, 10);

    const decision = agentAsks(claude, "tool-1");
    await appRequest(sent);
    turns.startTurn(turnStart(11, "next"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    claude.emit(sdk(INIT));
    claude.emit(sdk(answer("msg-2", "own words")));
    stop(claude);
    expect((await decision)?.behavior).toBe("deny");
    await until(() => completedTurnStatuses(sent).length === 3);

    expect(completedTurns(sent).slice(1)).toMatchObject([
      { id: "turn-2", status: "failed" },
      { id: "turn-3", status: "failed" },
    ]);
    expect(
      sent.find(
        (m) =>
          m.method === "item/completed" &&
          m.params.turnId === "turn-3" &&
          m.params.item.type === "agentMessage",
      )?.params.item,
    ).toMatchObject({ text: "own words" });
    expect(next.started()).toBe(false);
  });

  test.each<{
    name: string;
    stop: (claude: ReturnType<typeof fakeClaude>) => void;
  }>([
    { name: "ends", stop: (claude) => claude.end() },
    {
      name: "fails",
      stop: (claude) => claude.fail(new Error("socket closed")),
    },
  ])("declines the approvals and fails both turns when Claude's stream $name after it started a turn during the wait", async ({
    stop,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);

    const decision = agentAsks(claude, "tool-1");
    await appRequest(sent);
    claude.emit(sdk(INIT));
    claude.emit(sdk(answer("msg-2", "the agent finished")));
    stop(claude);
    expect((await decision)?.behavior).toBe("deny");
    await until(() => completedTurnStatuses(sent).length === 3);

    expect(completedTurns(sent).slice(1)).toMatchObject([
      { id: "turn-2", status: "failed" },
      { id: "turn-3", status: "failed" },
    ]);
    expect(claude.closes()).toBeGreaterThan(0);
  });

  test("shows a main agent's approval that comes while a turn Claude started waits behind the approval turn in that turn without an item", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);

    const background = agentAsks(claude, "tool-1");
    await until(() => askedRequests(sent).length === 1);
    claude.emit(sdk(INIT));
    claude.emit(sdk(answer("msg-2", "the agent finished")));
    await settle();
    const main = askTool(
      claude,
      "Bash",
      { command: "rm -rf build" },
      { toolUseID: "tool-2" },
    );
    await until(() => askedRequests(sent).length === 2);
    const [first, second] = askedRequests(sent);
    turns.answerRequest({ id: first.id, result: ALLOWED });
    turns.answerRequest({ id: second.id, result: ALLOWED });
    expect(await background).toEqual({ behavior: "allow" });
    expect(await main).toEqual({ behavior: "allow" });
    claude.emit(sdk(ownResult()));
    await until(() => completedTurnStatuses(sent).length === 3);

    expect(second).toMatchObject({
      method: "item/tool/requestUserInput",
      params: { turnId: "turn-2" },
    });
    const held = sent.slice(
      sent.findIndex(isTurnStarted("turn-2")),
      sent.findIndex(isTurnStarted("turn-3")),
    );
    expect(held.filter((m) => m.method === "item/started")).toEqual([]);
    expect(completedTurns(sent).slice(1)).toMatchObject([
      { id: "turn-2", status: "completed" },
      {
        id: "turn-3",
        status: "completed",
        items: [{ text: "the agent finished" }],
      },
    ]);
  });

  test("runs a turn the app queued behind the approval turn once the app interrupts it", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);
    const prompts = claude.prompt()?.[Symbol.asyncIterator]();
    await prompts?.next();

    const decision = agentAsks(claude, "tool-1");
    await appRequest(sent);
    turns.startTurn(turnStart(11, "next"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    turns.interruptTurn(interrupt(20, "turn-2"));
    expect((await decision)?.behavior).toBe("deny");
    const next = await prompts?.next();
    claude.emit(sdk(answer("msg-3", "hi")));
    claude.emit(sdk(success([next?.value?.uuid])));
    await until(() => completedTurnStatuses(sent).length === 3);

    expect(next?.value?.message.content).toBe("next");
    expect(completedTurns(sent).slice(1)).toMatchObject([
      { id: "turn-2", status: "interrupted" },
      { id: "turn-3", status: "completed", items: [{ text: "hi" }] },
    ]);
    expect(claude.interrupts()).toBe(0);
  });

  test("opens another turn for an approval that comes after the approval turn ended but before the thread is idle", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const asked: { decision?: ReturnType<typeof askTool> } = {};
    const { turns, sent } = await harness([claude], {
      onSend: (message) => {
        if (
          isTurnCompleted("turn-2")(message) &&
          asked.decision === undefined
        ) {
          asked.decision = agentAsks(claude, "tool-2");
        }
      },
    });
    await completeTurn(turns, sent, claude, 10);

    const first = agentAsks(claude, "tool-1");
    const request = await appRequest(sent);
    turns.answerRequest({ id: request.id, result: ALLOWED });
    expect(await first).toEqual({ behavior: "allow" });
    await until(() => askedRequests(sent).length === 2);
    turns.answerRequest({ id: askedRequests(sent)[1].id, result: ALLOWED });
    await until(() => completedTurnStatuses(sent).length === 3);

    expect(await asked.decision).toEqual({ behavior: "allow" });
    expect(askedRequests(sent)[1].params.turnId).toBe("turn-3");
    expect(completedTurnStatuses(sent)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
  });

  test("waits past a turn the user stopped before it was shown and holds the approval in a turn after it", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const asked: { decision?: ReturnType<typeof askTool> } = {};
    const { turns, sent } = await harness([claude], {
      onSend: (message) => {
        if (
          isTurnCompleted("turn-1")(message) &&
          asked.decision === undefined
        ) {
          asked.decision = agentAsks(claude, "tool-1");
        }
      },
    });
    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.startTurn(turnStart(11, "next"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    turns.interruptTurn(interrupt(20, "turn-2"));

    claude.emit(sdk(success()));
    const request = await appRequest(sent);
    turns.answerRequest({ id: request.id, result: ALLOWED });
    await until(() => completedTurnStatuses(sent).length === 3);

    expect(await asked.decision).toEqual({ behavior: "allow" });
    expect(request.params.turnId).toBe("turn-3");
    expect(completedTurnStatuses(sent)).toEqual([
      "completed",
      "interrupted",
      "completed",
    ]);
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
    await turns.steerTurn(steer(30, "turn-2", "also this"));

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
  ])("declines the approvals the turn holds and fails it when $name", async ({
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
    expect(completedTurns(sent)[1]).toMatchObject({
      id: "turn-2",
      status: "failed",
      error: {
        message: "Claude's session ended before the approval was answered",
      },
    });
    expect(resolvedRequests(sent)).toEqual(
      askedRequests(sent).map((m) => m.id),
    );
    await until(() => claude.closes() > 0);
  });

  test.each<{
    name: string;
    options: Parameters<typeof harness>[1];
    beforeAsk: (turns: Turns) => void;
  }>([
    {
      name: "the app cannot be shown a turn of Claude's own",
      options: { ownTurnsShown: false },
      beforeAsk: () => {},
    },
    {
      name: "the bridge has closed",
      options: {},
      beforeAsk: (turns) => turns.closeAll(),
    },
  ])("declines an approval without opening a turn when $name", async ({
    options,
    beforeAsk,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude], options);
    await completeTurn(turns, sent, claude, 10);
    beforeAsk(turns);

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
    await until(() => claude.prompted());
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

const startedTurn = async (claude: ReturnType<typeof fakeClaude>) => {
  const started = await harness([claude]);
  started.turns.startTurn(turnStart(10, "hello"), undefined);
  await until(() => claude.prompted());
  return started;
};

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

const agentThreadWithApprovalWaiting = async (claude: FakeClaude) => {
  const started = await harness([claude]);
  const { turns, sent, subagents } = started;
  turns.startTurn(turnStart(10, "hello"), undefined);
  await until(() => claude.started());
  const prompts = claude.prompt()?.[Symbol.asyncIterator]();
  await prompts?.next();
  claude.emit(sdk(taskStarted("toolu-agent", 1)));
  claude.emit(sdk(success()));
  await until(() => turnCompleted(sent) !== undefined);
  const childItems = childItemsOf(sent, subagents.childrenOf(THREAD)[0]?.id);

  const decision = agentAsks(claude, "tool-1");
  const request = await appRequest(sent);
  return { ...started, prompts, childItems, decision, request };
};

const claudeRunsAgentToolInOwnTurn = async (
  claude: FakeClaude,
  sent: Sent[],
  childItems: ReturnType<typeof childItemsOf>,
) => {
  claude.emit(sdk(INIT));
  claude.emit(sdk(answer("msg-2", "the agent finished")));
  claude.emit(
    sdk({ ...bashCall("toolu-ls"), parent_tool_use_id: "toolu-agent" }),
  );
  claude.emit(
    sdk({ ...toolError("toolu-ls"), parent_tool_use_id: "toolu-agent" }),
  );
  claude.emit(sdk(BACKGROUND_AGENT_SPOKE));
  await until(
    () =>
      childItems("item/completed", "commandExecution").length === 1 &&
      childItems("item/started", "agentMessage").length === 1,
  );
  claude.emit(sdk(ownResult()));
  await until(() => claude.drained());
  expect(completedTurnStatuses(sent)).toEqual(["completed"]);
};

const expectAgentToolShownOnce = (
  childItems: ReturnType<typeof childItemsOf>,
) => {
  expect(childItems("item/started", "commandExecution")).toHaveLength(1);
  expect(childItems("item/completed", "commandExecution")).toHaveLength(1);
  expect(childItems("item/started", "agentMessage")).toHaveLength(1);
};

const askedRequests = (sent: Sent[]) =>
  sent.filter((m) => typeof m.id === "string" && m.id.startsWith("harnexus-"));

const childItemsOf =
  (sent: Sent[], childId: string | undefined) =>
  (method: string, type: string) =>
    sent.filter(
      (m) =>
        m.method === method &&
        m.params.threadId === childId &&
        m.params.item.type === type,
    );

const isTurnCompleted = (turnId: string) => (message: Sent) =>
  message.method === "turn/completed" && message.params.turn.id === turnId;

const BACKGROUND_AGENT_SPOKE = {
  ...answer("msg-agent", "working"),
  parent_tool_use_id: "toolu-agent",
};

const DENIED = { answers: { approval: { answers: ["Deny"] } } };

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
