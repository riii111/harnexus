import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AccountInfo,
  type CanUseTool,
  createSdkMcpServer,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Result } from "better-result";
import {
  FileWriteFailed,
  removeFile,
  writeFileAtomic,
} from "../boundary/fs.ts";
import { fakeClaude } from "../boundary/testing/fake-claude.ts";
import {
  type ClaudeSessionSettings,
  startClaudeSession,
} from "../claude/session.ts";
import { openThreadStore } from "../state/thread-store.ts";
import { createTurnController, type TurnEvent } from "./controller.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-turn-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("turn/start on a Claude thread", () => {
  test("answers with the turn, sends the prompt and completes from Claude's result", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store, settings } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    expect(await firstPrompt(claude.prompt())).toBe("hello");
    claude.emit(sdk(answer("msg-1", "hi")));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    expect(sent.slice(0, 3).map((m) => m.method ?? "response")).toEqual([
      "thread/status/changed",
      "turn/started",
      "response",
    ]);
    expect(responseTo(sent, 10)?.result.turn).toMatchObject({
      id: "turn-1",
      status: "inProgress",
    });
    expect(settings[0]).toMatchObject({ cwd: dir, model: MODEL });
    expect(turnCompleted(sent)).toMatchObject({ status: "completed" });
    await until(() => store.get(THREAD)?.runState === "idle");
    expect(store.get(THREAD)).toMatchObject({
      sessionId: "se-1",
      worktree: dir,
      model: MODEL,
    });
  });

  test("logs a turn Claude completes as finished", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, events } = await harness([claude]);

    await completeTurn(turns, sent, claude, 10);

    expect(
      events.filter(
        (event) => event.event === "claude_turn" && event.step === "finished",
      ),
    ).toEqual([
      {
        event: "claude_turn",
        step: "finished",
        status: "completed",
        error: null,
      },
    ]);
  });

  test("keeps one Claude session for the thread across turns", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([claude]);

    await completeTurn(turns, sent, claude, 10);
    await completeTurn(turns, sent, claude, 11);

    expect(settings).toHaveLength(1);
    expect(turnsCompleted(sent)).toEqual(["completed", "completed"]);
  });

  test("accepts the next turn sent while the app receives turn/completed", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    let startNext = () => {};
    const { turns, sent } = await harness([claude], {
      onSend: (message) => {
        if (message.method === "turn/completed") startNext();
      },
    });
    startNext = () => turns.startTurn(turnStart(11, "again"), undefined);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    claude.emit(sdk(answer("msg-1", "hi")));
    claude.emit(sdk(success()));
    await until(() => responseTo(sent, 11) !== undefined);

    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-2" });
  });

  test("fails the turn when the login is not a subscription", async () => {
    const claude = fakeClaude({ apiProvider: "bedrock" });
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => turnCompleted(sent) !== undefined);

    expect(responseTo(sent, 10)?.result).toBeDefined();
    expect(turnCompleted(sent)).toMatchObject({ status: "failed" });
  });

  test("resumes the session after the stream fails", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([first, second]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => first.started());
    first.emit(sdk(answer("msg-1", "partial")));
    first.fail(new Error("socket closed"));
    await until(() => turnCompleted(sent) !== undefined);
    await completeTurn(turns, sent, second, 11);

    expect(turnsCompleted(sent)).toEqual(["failed", "completed"]);
    expect(first.closes()).toBe(1);
    expect(settings[1]).toMatchObject({ resume: "se-1" });
  });
});

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

  test("asks a subagent's tool without adding an item to the thread", async () => {
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

  test("denies a tool asked outside a running turn without asking the app", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);

    const decision = await askTool(claude, "Bash", { command: "ls" });

    expect(decision?.behavior).toBe("deny");
    expect(sent.filter((m) => m.method?.endsWith("requestApproval"))).toEqual(
      [],
    );
  });

  test.each<{ name: string; stop: (turns: Turns) => void }>([
    {
      name: "the turn is interrupted",
      stop: (turns) => turns.interruptTurn(interrupt(20, "turn-1")),
    },
    { name: "the bridge closes", stop: (turns) => turns.closeAll() },
  ])("denies a waiting tool and closes its prompt when $name", async ({
    stop,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const { turns, sent } = await startedTurn(claude);

    const decision = askTool(claude, "Bash", { command: "ls" });
    const request = await appRequest(sent);
    stop(turns);

    expect((await decision)?.behavior).toBe("deny");
    expect(resolvedRequests(sent)).toEqual([request.id]);
  });

  test("denies a waiting tool and closes its prompt when the turn fails", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { sent } = await startedTurn(claude);

    const decision = askTool(claude, "Bash", { command: "ls" });
    const request = await appRequest(sent);
    claude.fail(new Error("socket closed"));

    expect((await decision)?.behavior).toBe("deny");
    expect(turnCompleted(sent)).toMatchObject({ status: "failed" });
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

  test("fails the turn without sending the prompt when Claude refuses the mode", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      permissionModeError: new Error("no control channel"),
    });
    const { turns, sent, events } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => turnCompleted(sent) !== undefined);

    expect(turnCompleted(sent)).toMatchObject({ status: "failed" });
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "finished",
        error: "ClaudePermissionModeFailed",
      }),
    );
    expect(claude.closes()).toBe(1);
    expect(await claude.prompts()).toEqual([]);
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

describe("turn/interrupt", () => {
  test("replies before the turn completes as interrupted", async () => {
    const claude = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.interruptTurn(interrupt(20, "turn-1"));
    await until(() => claude.interrupts() === 1);
    claude.emit(
      sdk(result({ subtype: "error_during_execution", is_error: true })),
    );
    await until(() => turnCompleted(sent) !== undefined);

    expect(turnCompleted(sent)).toMatchObject({ status: "interrupted" });
    const reply = sent.findIndex((m) => m.id === 20);
    const completed = sent.findIndex((m) => m.method === "turn/completed");
    expect(sent[reply]).toEqual({ id: 20, result: {} });
    expect(reply).toBeLessThan(completed);
    expect(claude.closes()).toBe(0);
  });

  test.each<{ name: string; options: Parameters<typeof fakeClaude>[1] }>([
    { name: "a send still queued", options: { stillQueued: ["uuid-queued"] } },
    { name: "no receipt from an older CLI", options: {} },
    {
      name: "an error",
      options: { interruptError: new Error("no control channel") },
    },
  ])("closes Claude after an interrupt that answers with $name", async ({
    options,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION, options);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.interruptTurn(interrupt(20, "turn-1"));
    await until(() => turnCompleted(sent) !== undefined);

    expect(turnCompleted(sent)).toMatchObject({ status: "interrupted" });
    expect(claude.closes()).toBe(1);
  });

  test("waits for a late interrupt receipt before the next turn reuses the session", async () => {
    const gate = createGate();
    const first = fakeClaude(SUBSCRIPTION, {
      stillQueued: ["uuid-queued"],
      interruptAnswered: gate.promise,
    });
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([first, second]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => first.started());
    first.emit(sdk(answer("msg-1", "partial")));
    turns.interruptTurn(interrupt(20, "turn-1"));
    first.emit(
      sdk(result({ subtype: "error_during_execution", is_error: true })),
    );
    await until(() => turnCompleted(sent) !== undefined);
    turns.startTurn(turnStart(11, "again"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    expect(settings).toHaveLength(1);
    gate.open();
    await until(() => second.started());

    expect(turnCompleted(sent)).toMatchObject({ status: "interrupted" });
    expect(first.closes()).toBe(1);
    expect(settings[1]).toMatchObject({ resume: "se-1" });
  });

  test("stops a turn waiting on an earlier interrupt without asking Claude again", async () => {
    const gate = createGate();
    const first = fakeClaude(SUBSCRIPTION, {
      stillQueued: ["uuid-queued"],
      interruptAnswered: gate.promise,
    });
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([first, second]);
    await interruptBeforeReceipt(turns, sent, first);

    turns.startTurn(turnStart(11, "again"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    turns.interruptTurn(interrupt(21, "turn-2"));
    gate.open();
    await until(() => turnsCompleted(sent).length === 2);
    await completeTurn(turns, sent, second, 12);

    expect(responseTo(sent, 21)).toEqual({ id: 21, result: {} });
    expect(first.interrupts()).toBe(1);
    expect(turnsCompleted(sent)).toEqual([
      "interrupted",
      "interrupted",
      "completed",
    ]);
    expect(settings).toHaveLength(2);
  });

  test("starts no Claude for a waiting turn once the bridge is closing", async () => {
    const gate = createGate();
    const first = fakeClaude(SUBSCRIPTION, {
      stillQueued: ["uuid-queued"],
      interruptAnswered: gate.promise,
    });
    const { turns, sent, settings } = await harness([first]);
    await interruptBeforeReceipt(turns, sent, first);

    turns.startTurn(turnStart(11, "again"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    turns.closeAll();
    gate.open();
    await until(() => turnsCompleted(sent).length === 2);

    expect(turnsCompleted(sent)).toEqual(["interrupted", "failed"]);
    expect(settings).toHaveLength(1);
  });

  test("keeps an interrupt accepted while Claude was starting", async () => {
    const claude = fakeClaude({ apiProvider: "bedrock" });
    let start = () => {};
    const beforeStart = new Promise<void>((resolve) => {
      start = resolve;
    });
    const { turns, sent } = await harness([claude], { beforeStart });

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    turns.interruptTurn(interrupt(20, "turn-1"));
    start();
    await until(() => turnCompleted(sent) !== undefined);

    expect(responseTo(sent, 20)).toEqual({ id: 20, result: {} });
    expect(turnCompleted(sent)).toMatchObject({ status: "interrupted" });
  });

  test("refuses a turn that already completed", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    claude.emit(sdk(answer("msg-1", "hi")));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);
    turns.interruptTurn(interrupt(20, "turn-1"));

    expect(responseTo(sent, 20)?.error).toBeDefined();
    expect(claude.interrupts()).toBe(0);
  });

  test("asks Claude once when the stop is sent twice", async () => {
    const claude = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.interruptTurn(interrupt(20, "turn-1"));
    await until(() => claude.interrupts() === 1);
    await settle();
    turns.interruptTurn(interrupt(21, "turn-1"));
    await settle();

    expect(responseTo(sent, 21)).toEqual({ id: 21, result: {} });
    expect(claude.interrupts()).toBe(1);
  });

  test("refuses a turn id that is not running", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.interruptTurn(interrupt(20, "turn-9"));

    expect(responseTo(sent, 20)?.error).toBeDefined();
    expect(claude.interrupts()).toBe(0);
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
    expect(turnsCompleted(sent)).toEqual(["completed"]);
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
    await settle();
    expect(turnsCompleted(sent)).toEqual([]);
    claude.emit(sdk(answer("msg-2", "second")));
    claude.emit(sdk(success([steered?.uuid])));
    await until(() => turnCompleted(sent) !== undefined);

    expect(turnsCompleted(sent)).toEqual(["completed"]);
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
    expect(turnsCompleted(sent)).toEqual(["failed", "completed"]);
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
    await settle();
    expect(turnsCompleted(sent)).toEqual([]);
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

    expect(turnsCompleted(sent)).toEqual(["interrupted"]);
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
    expect(turnsCompleted(sent)).toEqual(["completed"]);
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

describe("model changes", () => {
  test("restart Claude on the new model at the next turn and resume the conversation", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings, store } = await harness([first, second]);

    await completeTurn(turns, sent, first, 10);
    turns.changeModel(THREAD, OTHER_MODEL);
    await completeTurn(turns, sent, second, 11);

    expect(first.closes()).toBe(1);
    expect(settings[1]).toMatchObject({ model: OTHER_MODEL, resume: "se-1" });
    expect(turns.threadOf(THREAD)?.model).toBe(OTHER_MODEL);
    await until(() => store.get(THREAD)?.model === OTHER_MODEL);
  });

  test("take the model a turn/start names from that turn", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([first, second]);
    await completeTurn(turns, sent, first, 10);

    const request = turnStart(11, "again");
    turns.startTurn(
      { ...request, params: { ...request.params, model: OTHER_MODEL } },
      undefined,
    );
    await until(() => second.started());

    expect(settings[1]).toMatchObject({ model: OTHER_MODEL, resume: "se-1" });
  });

  test("leave a turn accepted before the change on its model while it waits for an earlier stop", async () => {
    const gate = createGate();
    const first = fakeClaude(SUBSCRIPTION, {
      stillQueued: ["uuid-queued"],
      interruptAnswered: gate.promise,
    });
    const second = fakeClaude(SUBSCRIPTION);
    const third = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([first, second, third]);
    await interruptBeforeReceipt(turns, sent, first);

    turns.startTurn(turnStart(11, "again"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    turns.changeModel(THREAD, OTHER_MODEL);
    gate.open();
    await until(() => second.started());
    second.emit(sdk(success()));
    await until(() => turnsCompleted(sent).length === 2);
    await completeTurn(turns, sent, third, 12);

    expect(settings.map((session) => session.model)).toEqual([
      MODEL,
      MODEL,
      OTHER_MODEL,
    ]);
  });

  test("save a model picked while the thread's first turn registers it", async () => {
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

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => writes === 1);
    turns.changeModel(THREAD, OTHER_MODEL);
    firstWrite.open();
    await until(() => store.get(THREAD)?.model === OTHER_MODEL);

    expect(turns.threadOf(THREAD)?.model).toBe(OTHER_MODEL);
  });

  test("run a turn that lost the race to register the thread on the model it asked for", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([first, second], {
      adopt: false,
    });
    const request = turnStart(10, "hello");
    const withModel = (id: number, model: string) => ({
      ...request,
      id,
      params: { ...request.params, model, cwd: dir },
    });

    turns.startTurn(withModel(10, MODEL), undefined);
    turns.startTurn(withModel(11, OTHER_MODEL), undefined);
    await until(() => first.started());
    first.emit(sdk(success()));
    await until(() => second.started());

    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-2" });
    expect(settings.map((session) => session.model)).toEqual([
      MODEL,
      OTHER_MODEL,
    ]);
  });

  test("leave the running turn on its model", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.changeModel(THREAD, OTHER_MODEL);
    claude.emit(sdk(answer("msg-1", "hi")));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    expect(turnCompleted(sent)).toMatchObject({ status: "completed" });
    expect(claude.closes()).toBe(0);
    expect(settings).toHaveLength(1);
  });

  test("keep a model the store failed to save while the bridge runs", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    let writes = 0;
    const { turns, sent, settings, events } = await harness([first, second], {
      files: {
        writeState: async (target, content) =>
          ++writes <= 2 ? writeFileAtomic(target, content) : diskFull(target),
      },
    });

    await completeTurn(turns, sent, first, 10);
    turns.changeModel(THREAD, OTHER_MODEL);
    await until(() => events.some((event) => event.step === "model_not_saved"));
    await completeTurn(turns, sent, second, 11);

    expect(events).toContainEqual({
      event: "claude_turn",
      step: "model_not_saved",
      error: "StatePersistFailed",
    });
    expect(settings[1]).toMatchObject({ model: OTHER_MODEL });
  });
});

describe("refused requests", () => {
  test.each([
    { name: "non-text input", override: { input: [{ type: "image" }] } },
    { name: "a Codex model", override: { model: "gpt-fixture" } },
    {
      name: "a Codex model in the collaboration mode alone",
      override: {
        collaborationMode: { mode: "default", settings: { model: "gpt-x" } },
      },
    },
    { name: "another working directory", override: { cwd: "/elsewhere" } },
  ])("refuses $name without starting Claude", async ({ override }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    const request = turnStart(10, "hello");
    turns.startTurn(
      { ...request, params: { ...request.params, ...override } },
      undefined,
    );
    await settle();

    expect(sent).toEqual([REFUSED(10)]);
    expect(claude.started()).toBe(false);
  });

  test("answers a rejected request with the given message", async () => {
    const { turns, sent } = await harness([]);

    turns.reject({ id: 12 }, "not yet");

    expect(sent).toEqual([
      { id: 12, error: { code: -32600, message: "not yet" } },
    ]);
  });

  test("fails a turn asking for another directory that lost the race to register the thread", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([claude], {
      adopt: false,
    });
    const request = turnStart(10, "hello");
    const first = {
      ...request,
      params: { ...request.params, model: MODEL, cwd: dir },
    };

    turns.startTurn(first, undefined);
    turns.startTurn(
      { ...first, id: 11, params: { ...first.params, cwd: "/elsewhere" } },
      undefined,
    );
    await until(() => completedOn(sent, THREAD) !== undefined);
    await until(() => claude.started());

    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-2" });
    expect(completedOn(sent, THREAD)).toMatchObject({
      id: "turn-2",
      status: "failed",
      error: {
        message:
          "changing the working directory of a Claude thread is not supported",
      },
    });
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({ cwd: dir });
  });

  test("switches a Codex thread to Claude only when its directory is known", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([claude], {
      adopt: false,
    });
    const request = turnStart(10, "hello");
    const withModel = {
      ...request,
      params: { ...request.params, model: MODEL },
    };

    turns.startTurn(withModel, undefined);
    turns.startTurn({ ...withModel, id: 11 }, dir);
    await until(() => claude.started());

    expect(responseTo(sent, 10)?.error).toBeDefined();
    expect(settings[0]).toMatchObject({ cwd: dir, model: MODEL });
  });
});

describe("turn/start arriving on a busy thread", () => {
  test("answers at once, waits for the running turn and then continues the same Claude session", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings, events } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    turns.startTurn(turnStart(11, "reply"), undefined);
    await settle();
    expect(responseTo(sent, 11)?.result.turn).toMatchObject({
      id: "turn-2",
      status: "inProgress",
    });
    expect(startedTurns(sent)).toEqual(["turn-1"]);
    claude.emit(sdk(answer("msg-1", "hi")));
    claude.emit(sdk(success()));
    await until(() => startedTurns(sent).length === 2);
    claude.emit(sdk(answer("msg-2", "ok")));
    claude.emit(sdk(success()));
    await until(() => turnsCompleted(sent).length === 2);

    expect(sent.filter((m) => m.id === 11)).toHaveLength(1);
    expect(startedTurns(sent)).toEqual(["turn-1", "turn-2"]);
    expect(turnsCompleted(sent)).toEqual(["completed", "completed"]);
    expect(await promptsUntil(claude, 2)).toEqual(["hello", "reply"]);
    expect(settings).toHaveLength(1);
    expect(events).toContainEqual({ event: "claude_turn", step: "queued" });
  });

  test("stops an answered waiting turn before it reaches Claude and leaves the running turn's prompt open", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    const decision = askTool(claude, "Bash", { command: "ls" });
    const request = await appRequest(sent);
    turns.startTurn(turnStart(11, "reply"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);

    turns.interruptTurn(interrupt(21, "turn-2"));

    expect(responseTo(sent, 21)).toEqual({ id: 21, result: {} });
    expect(resolvedRequests(sent)).toEqual([]);
    expect(claude.interrupts()).toBe(0);
    turns.answerRequest({ id: request.id, result: { decision: "accept" } });
    expect(await decision).toEqual({ behavior: "allow" });
    claude.emit(sdk(success()));
    await until(() => turnsCompleted(sent).length === 2);
    expect(turnsCompleted(sent)).toEqual(["completed", "interrupted"]);
    await completeTurn(turns, sent, claude, 12);
    expect(await promptsUntil(claude, 2)).toEqual(["hello", "prompt 12"]);
  });

  test("stops a turn answered while the turn before it is still being cleared up", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const gate = createGate();
    let holdCleanup = false;
    const { turns, sent } = await harness([claude], {
      files: {
        removeMarker: async (target) => {
          if (holdCleanup) await gate.promise;
          return removeFile(target);
        },
      },
    });
    holdCleanup = true;
    await completeTurn(turns, sent, claude, 10);
    turns.startTurn(turnStart(11, "again"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);

    turns.interruptTurn(interrupt(21, "turn-2"));
    gate.open();
    await until(() => turnsCompleted(sent).length === 2);

    expect(responseTo(sent, 21)).toEqual({ id: 21, result: {} });
    expect(turnsCompleted(sent)).toEqual(["completed", "interrupted"]);
    await completeTurn(turns, sent, claude, 12);
    expect(await promptsUntil(claude, 2)).toEqual(["prompt 10", "prompt 12"]);
  });

  test("fails a waiting turn without its thread status once the bridge is closing", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.startTurn(turnStart(11, "reply"), undefined);
    turns.closeAll();
    await until(() => turnsCompleted(sent).length === 2);

    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-2" });
    expect(turnsCompleted(sent)).toEqual(["failed", "failed"]);
    const waiting = sent.filter(
      (m) => m.params?.turnId === "turn-2" || m.params?.turn?.id === "turn-2",
    );
    expect(waiting.map((m) => m.method)).toEqual([
      "turn/started",
      "item/started",
      "item/completed",
      "error",
      "turn/completed",
    ]);
    expect(waiting[1]?.params.item).toMatchObject({
      type: "userMessage",
      content: [{ type: "text", text: "reply" }],
    });
    expect(waiting.at(-1)?.params.turn.error.message).toBe(
      "the bridge is shutting down",
    );
    expect(
      sent
        .filter((m) => m.method === "thread/status/changed")
        .map((m) => m.params.status.type),
    ).toEqual(["active", "idle"]);
  });
});

describe("clientUserMessageId", () => {
  test("refuses a copy of a message that is still waiting to run", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.startTurn(withMessageId(turnStart(11, "reply"), "m-1"), undefined);
    turns.startTurn(withMessageId(turnStart(12, "reply"), "m-1"), undefined);
    claude.emit(sdk(success()));
    await until(() => responseTo(sent, 11) !== undefined);
    claude.emit(sdk(success()));
    await until(() => turnsCompleted(sent).length === 2);
    await settle();

    expect(responseTo(sent, 11)?.result).toBeDefined();
    expect(responseTo(sent, 12)).toEqual(DUPLICATE(12));
    expect(turnsCompleted(sent)).toEqual(["completed", "completed"]);
    const user = completedItems(sent).filter(
      (item) => item.type === "userMessage",
    );
    expect(user.map((item) => item.clientId)).toEqual([null, "m-1"]);
  });

  test("refuses a message delivered again after the bridge restarts", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const before = await harness([first]);
    before.turns.startTurn(
      withMessageId(turnStart(10, "reply"), "m-1"),
      undefined,
    );
    await until(() => responseTo(before.sent, 10) !== undefined);
    first.emit(sdk(success()));
    await until(() => before.store.get(THREAD)?.runState === "idle");
    expect(turnsCompleted(before.sent)).toEqual(["completed"]);
    const second = fakeClaude(SUBSCRIPTION);

    const after = await harness([second]);
    after.turns.startTurn(
      withMessageId(turnStart(11, "reply"), "m-1"),
      undefined,
    );
    await settle();

    expect(after.sent).toEqual([DUPLICATE(11)]);
    expect(second.started()).toBe(false);
  });

  test("refuses a message whose id cannot be saved without starting Claude", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    let writes = 0;
    const { turns, sent, store } = await harness([claude], {
      files: {
        writeState: async (target, content) =>
          ++writes === 2 ? diskFull(target) : writeFileAtomic(target, content),
      },
    });

    turns.startTurn(withMessageId(turnStart(10, "reply"), "m-1"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    await settle();

    expect(sent).toEqual([
      {
        id: 10,
        error: {
          code: -32600,
          message:
            "the message id could not be saved, so the message was not run to avoid running it twice",
        },
      },
    ]);
    expect(claude.started()).toBe(false);
    expect(store.get(THREAD)?.runState).toBe("idle");
  });

  test("accepts a message again after it was refused before running", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    let writes = 0;
    const { turns, sent } = await harness([claude], {
      files: {
        writeState: async (target, content) =>
          ++writes === 1 ? diskFull(target) : writeFileAtomic(target, content),
      },
    });

    turns.startTurn(withMessageId(turnStart(10, "reply"), "m-1"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    turns.startTurn(withMessageId(turnStart(11, "reply"), "m-1"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);

    expect(responseTo(sent, 10)?.error).toBeDefined();
    expect(responseTo(sent, 11)?.result.turn).toMatchObject({
      status: "inProgress",
    });
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

  test("leave the thread as outcome unknown after a turn with an undecided write and refuse the next turn", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store, events } = await harness([claude], {
      unsettledWrite: () => true,
    });

    await completeTurn(turns, sent, claude, 10);
    await until(() => store.get(THREAD)?.runState !== "running");
    turns.startTurn(turnStart(11, "again"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);

    expect(store.get(THREAD)?.runState).toBe("outcomeUnknown");
    expect(events).toContainEqual({
      event: "claude_turn",
      step: "outcome_unknown",
    });
    expect(responseTo(sent, 11)?.error.message).toContain("unknown outcome");
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

  test("clear the run state after a turn whose writes were all decided", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store } = await harness([claude], {
      unsettledWrite: () => false,
    });

    await completeTurn(turns, sent, claude, 10);
    await until(() => store.get(THREAD)?.runState !== "running");

    expect(store.get(THREAD)?.runState).toBe("idle");
  });
});

describe("several workers", () => {
  test("run their turns at once, each in its own directory, session and thread tools", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { sent, store, settings, links } = await twoWorkers([first, second]);

    await until(() => second.started());
    second.emit(sdk({ ...answer("msg-b", "ok"), session_id: "se-b" }));
    second.emit(sdk({ ...success(), session_id: "se-b" }));
    await until(() => completedOn(sent, OTHER_THREAD) !== undefined);
    expect(completedOn(sent, THREAD)).toBeUndefined();
    first.emit(sdk(answer("msg-a", "ok")));
    first.emit(sdk(success()));
    await until(() => completedOn(sent, THREAD) !== undefined);
    await until(
      () =>
        store.get(THREAD)?.runState === "idle" &&
        store.get(OTHER_THREAD)?.runState === "idle",
    );

    expect(settings.map((session) => session.cwd)).toEqual([dir, OTHER_DIR]);
    expect(links).toEqual([THREAD, OTHER_THREAD]);
    expect(store.get(THREAD)).toMatchObject({
      sessionId: "se-1",
      worktree: dir,
    });
    expect(store.get(OTHER_THREAD)).toMatchObject({
      sessionId: "se-b",
      worktree: OTHER_DIR,
    });
  });

  test("leave the other worker's turn and prompt open when one is stopped", async () => {
    const first = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await twoWorkers([first, second]);
    await until(() => second.started());
    const decision = askTool(second, "Bash", { command: "ls" });
    const request = await appRequest(sent);

    turns.interruptTurn(interrupt(20, "turn-1"));
    first.emit(
      sdk(result({ subtype: "error_during_execution", is_error: true })),
    );
    await until(() => completedOn(sent, THREAD) !== undefined);

    expect(request.params.threadId).toBe(OTHER_THREAD);
    expect(resolvedRequests(sent)).toEqual([]);
    expect(second.interrupts()).toBe(0);
    turns.answerRequest({ id: request.id, result: { decision: "accept" } });
    expect(await decision).toEqual({ behavior: "allow" });
    second.emit(sdk(success()));
    await until(() => completedOn(sent, OTHER_THREAD) !== undefined);
    expect(completedOn(sent, THREAD)).toMatchObject({ status: "interrupted" });
    expect(completedOn(sent, OTHER_THREAD)).toMatchObject({
      status: "completed",
    });
  });

  test("keep the other worker running when one worker's Claude fails", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { sent } = await twoWorkers([first, second]);
    await until(() => second.started());

    first.fail(new Error("socket closed"));
    await until(() => completedOn(sent, THREAD) !== undefined);
    second.emit(sdk(success()));
    await until(() => completedOn(sent, OTHER_THREAD) !== undefined);

    expect(completedOn(sent, THREAD)).toMatchObject({ status: "failed" });
    expect(completedOn(sent, OTHER_THREAD)).toMatchObject({
      status: "completed",
    });
    expect(first.closes()).toBe(1);
    expect(second.closes()).toBe(0);
  });
});

describe("turn/start carrying another thread's message", () => {
  test("refuses a message from a reviewer that another worker created", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, events } = await registeredWorkers([claude]);

    turns.startTurn(reply(10, THREAD, OTHER_REVIEWER), undefined);
    await settle();

    expect(sent).toEqual([
      {
        id: 10,
        error: {
          code: -32600,
          message:
            "this message comes from a reviewer of another Claude thread",
        },
      },
    ]);
    expect(events).toContainEqual({
      event: "claude_turn",
      step: "refused",
      reason: "reply_to_other_worker",
      error: null,
    });
    expect(claude.started()).toBe(false);
  });

  test("refuses a message from a reviewer another worker is still saving", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const gate = createGate();
    let holdWrites = false;
    const { turns, sent, store } = await registeredWorkers([claude], {
      writeState: async (target, content) => {
        if (holdWrites) await gate.promise;
        return writeFileAtomic(target, content);
      },
    });
    holdWrites = true;
    const adding = store.addReviewer(THREAD, NEW_REVIEWER);

    turns.startTurn(reply(10, OTHER_THREAD, NEW_REVIEWER), undefined);
    await settle();
    gate.open();

    expect(sent).toEqual([
      {
        id: 10,
        error: {
          code: -32600,
          message:
            "this message comes from a reviewer of another Claude thread",
        },
      },
    ]);
    expect(claude.started()).toBe(false);
    const added = await adding;
    expect(added.isOk() && added.value.reviewerThreadIds).toEqual([
      NEW_REVIEWER,
    ]);
  });

  test.each([
    {
      name: "its own reviewer",
      threadId: OTHER_THREAD,
      source: OTHER_REVIEWER,
    },
    {
      name: "a thread that is no reviewer",
      threadId: THREAD,
      source: "th-lead",
    },
  ])("passes a message from $name to Claude and shows it as the call output the app labels as sent from another thread", async ({
    threadId,
    source,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await registeredWorkers([claude]);

    turns.startTurn(reply(10, threadId, source), undefined);
    await until(() => claude.started());

    expect(await firstPrompt(claude.prompt())).toBe(delegation(source));
    const shown = sent
      .filter((m) => m.method === "item/started")
      .map((m) => m.params.item);
    expect(shown).toEqual([
      {
        type: "functionCallOutput",
        id: expect.any(String),
        name: "send_message_to_thread",
        namespace: "codex_app",
        output: delegation(source),
      },
    ]);
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
    expect(turnsCompleted(sent)).toEqual(["completed", "completed"]);
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
    await until(() => turnsCompleted(sent).length === 2);

    expect(claude.closes()).toBe(0);
    expect(settings).toHaveLength(1);
    expect(turnsCompleted(sent)).toEqual(["completed", "completed"]);
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
    expect(turnsCompleted(sent)).toEqual(["completed", "completed"]);
  });
});

describe("closeAll", () => {
  test("stops Claude and ends the running turn as failed", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.closeAll();
    await until(() => turnCompleted(sent) !== undefined);

    expect(claude.closes()).toBe(1);
    expect(turnCompleted(sent)).toMatchObject({ status: "failed" });
  });

  test("refuses a turn that arrives after closing", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.closeAll();
    turns.startTurn(turnStart(11, "again"), undefined);
    await settle();

    expect(sent).toEqual([
      {
        id: 11,
        error: { code: -32600, message: "the bridge is shutting down" },
      },
    ]);
    expect(claude.started()).toBe(false);
  });
});

const startedTurn = async (claude: ReturnType<typeof fakeClaude>) => {
  const started = await harness([claude]);
  started.turns.startTurn(turnStart(10, "hello"), undefined);
  await until(() => claude.started());
  return started;
};

const askTool = (
  claude: ReturnType<typeof fakeClaude>,
  toolName: string,
  input: Record<string, unknown>,
  options: {
    agentID?: string;
    signal?: AbortSignal;
    defaultToNo?: boolean;
  } = {},
) => {
  const canUseTool = claude.options().canUseTool as CanUseTool;
  return canUseTool(toolName, input, {
    signal: options.signal ?? new AbortController().signal,
    toolUseID: "tool-1",
    requestId: "request-1",
    ...(options.agentID === undefined ? {} : { agentID: options.agentID }),
    ...(options.defaultToNo === undefined
      ? {}
      : { defaultToNo: options.defaultToNo }),
  });
};

const appRequest = async (sent: Sent[]) => {
  const find = () =>
    sent.find((m) => typeof m.id === "string" && m.id.startsWith("harnexus-"));
  await until(() => find() !== undefined);
  return find();
};

const resolvedRequests = (sent: Sent[]) =>
  sent
    .filter((m) => m.method === "serverRequest/resolved")
    .map((m) => m.params.requestId);

type Turns = ReturnType<typeof createTurnController>;

const diskFull = async (target: string) =>
  Result.err(
    new FileWriteFailed({
      path: target,
      cause: new Error("disk full"),
      message: `cannot write ${target}`,
    }),
  );

// Leaves turn-1 ended by its result while the interrupt receipt is still held back.
const interruptBeforeReceipt = async (
  turns: ReturnType<typeof createTurnController>,
  sent: Sent[],
  claude: ReturnType<typeof fakeClaude>,
) => {
  turns.startTurn(turnStart(10, "hello"), undefined);
  await until(() => claude.started());
  turns.interruptTurn(interrupt(20, "turn-1"));
  claude.emit(
    sdk(result({ subtype: "error_during_execution", is_error: true })),
  );
  await until(() => turnCompleted(sent) !== undefined);
  expect(turnCompleted(sent)).toMatchObject({ status: "interrupted" });
};

// The harness hands out fakes in the order Claude starts, so OTHER_THREAD waits until THREAD has taken the first.
const twoWorkers = async (fakes: ReturnType<typeof fakeClaude>[]) => {
  const started = await harness(fakes);
  started.turns.adopt(OTHER_THREAD, { model: MODEL, cwd: OTHER_DIR });
  started.turns.startTurn(turnStart(10, "hello"), undefined);
  await until(() => fakes[0]?.started() === true);
  started.turns.startTurn(turnStart(11, "hello", OTHER_THREAD), undefined);
  return started;
};

const registeredWorkers = async (
  fakes: ReturnType<typeof fakeClaude>[],
  files: Parameters<typeof openThreadStore>[1] = {},
) => {
  const started = await harness(fakes, { adopt: false, files });
  for (const [threadId, worktree] of [
    [THREAD, dir],
    [OTHER_THREAD, OTHER_DIR],
  ] as const) {
    const registered = await started.store.register({
      threadId,
      model: MODEL,
      worktree,
    });
    expect(registered.isOk() && registered.value.threadId).toBe(threadId);
  }
  const added = await started.store.addReviewer(OTHER_THREAD, OTHER_REVIEWER);
  expect(added.isOk() && added.value.reviewerThreadIds).toEqual([
    OTHER_REVIEWER,
  ]);
  return started;
};

const reply = (id: number, threadId: string, source: string) => ({
  id,
  params: {
    threadId,
    input: [],
    toolOutput: {
      name: "send_message_to_thread",
      namespace: "codex_app",
      output: delegation(source),
    },
  } as Record<string, unknown>,
});

const delegation = (source: string) =>
  `<codex_delegation>\n  <source_thread_id>${source}</source_thread_id>\n  <input>review done</input>\n</codex_delegation>`;

const startedTurns = (sent: Sent[]) =>
  sent
    .filter((message) => message.method === "turn/started")
    .map((message) => message.params.turn.id);

const completedOn = (sent: Sent[], threadId: string) =>
  sent.find(
    (message) =>
      message.method === "turn/completed" &&
      message.params.threadId === threadId,
  )?.params.turn;

const createGate = () => {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

const THREAD = "th-fixture-1";
const OTHER_THREAD = "th-fixture-2";
const OTHER_DIR = "/work/other-worktree";
const OTHER_REVIEWER = "th-fixture-reviewer-2";
const NEW_REVIEWER = "th-fixture-reviewer-1";
const MODEL = "claude-sonnet-5";
const OTHER_MODEL = "claude-opus-5-5";
const SUBSCRIPTION: AccountInfo = {
  subscriptionType: "Claude Max",
  apiProvider: "firstParty",
};

// biome-ignore lint/suspicious/noExplicitAny: messages are checked by shape in each test.
type Sent = any;

const harness = async (
  fakes: ReturnType<typeof fakeClaude>[],
  {
    adopt = true,
    files = {},
    beforeStart = Promise.resolve(),
    onSend = () => {},
    unsettledWrite = () => false,
    idleSessionMs,
  }: {
    adopt?: boolean;
    files?: Parameters<typeof openThreadStore>[1];
    beforeStart?: Promise<void>;
    onSend?: (message: Sent) => void;
    unsettledWrite?: () => boolean;
    idleSessionMs?: number;
  } = {},
) => {
  const opened = await openThreadStore(join(dir, "threads.json"), files);
  if (opened.isErr()) return expect.unreachable(opened.error.message);
  const store = opened.value;
  const sent: Sent[] = [];
  const events: TurnEvent[] = [];
  const settings: ClaudeSessionSettings[] = [];
  const links: string[] = [];
  const gates: string[] = [];
  let turnCount = 0;
  const turns = createTurnController({
    store,
    openLink: (threadId) => {
      links.push(threadId);
      return {
        server: createSdkMcpServer({ name: "codex_link", tools: [] }),
        allowedTools: ALLOWED_TOOLS,
        hasUnsettledWrite: unsettledWrite,
        stopWrites: () => gates.push("stop"),
        acceptWrites: () => gates.push("accept"),
      };
    },
    send: (message) => {
      sent.push(message);
      onSend(message);
    },
    log: (event) => events.push(event),
    startSession: async (session) => {
      const fake = fakes[settings.length];
      settings.push(session);
      if (fake === undefined) return expect.unreachable("no fake Claude left");
      await beforeStart;
      return startClaudeSession(session, fake.runtime);
    },
    now: () => 1_700_000_000_000,
    newTurnId: () => `turn-${++turnCount}`,
    ...(idleSessionMs !== undefined && { idleSessionMs }),
  });
  if (adopt) turns.adopt(THREAD, { model: MODEL, cwd: dir });
  return {
    turns,
    sent,
    events,
    store,
    settings,
    links,
    gates,
  };
};

const completeTurn = async (
  turns: ReturnType<typeof createTurnController>,
  sent: Sent[],
  claude: ReturnType<typeof fakeClaude>,
  id: number,
) => {
  const before = turnsCompleted(sent).length;
  turns.startTurn(turnStart(id, `prompt ${id}`), undefined);
  await until(() => responseTo(sent, id) !== undefined);
  claude.emit(sdk(answer(`msg-${id}`, "ok")));
  claude.emit(sdk(success()));
  await until(() => turnsCompleted(sent).length > before);
};

const turnStart = (id: number, text: string, threadId = THREAD) => ({
  id,
  params: {
    threadId,
    input: [{ type: "text", text, text_elements: [] }],
  } as Record<string, unknown>,
});

const steer = (id: number, turnId: string, text: string) => ({
  id,
  params: {
    threadId: THREAD,
    expectedTurnId: turnId,
    input: [{ type: "text", text, text_elements: [] }],
  } as Record<string, unknown>,
});

const withMessageId = (
  request: ReturnType<typeof turnStart>,
  clientUserMessageId: string,
) => ({ ...request, params: { ...request.params, clientUserMessageId } });

const interrupt = (id: number, turnId: string) => ({
  id,
  params: { threadId: THREAD, turnId },
});

// Long enough for a turn that was wrongly accepted to reach Claude.
const settle = () => Bun.sleep(20);

const DUPLICATE = (id: number) => ({
  id,
  error: {
    code: -32600,
    message: "this message was already delivered to the Claude thread",
  },
});

const ALLOWED_TOOLS = ["mcp__codex_link__read_thread"];

const REFUSED = (id: number) => ({
  id,
  error: { code: -32600, message: expect.any(String) },
});

const until = async (condition: () => boolean) => {
  for (let waited = 0; !condition(); waited += 2) {
    if (waited > 2000) return expect.unreachable("condition never held");
    await Bun.sleep(2);
  }
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

const firstPrompt = async (prompt: AsyncIterable<SDKUserMessage> | null) => {
  if (prompt === null) return null;
  const next = await prompt[Symbol.asyncIterator]().next();
  return next.done === true ? null : next.value.message.content;
};

const promptsUntil = async (
  claude: ReturnType<typeof fakeClaude>,
  count: number,
) => {
  const prompt = claude.prompt();
  if (prompt === null) return [];
  const iterator = prompt[Symbol.asyncIterator]();
  const texts: unknown[] = [];
  while (texts.length < count) {
    const next = await iterator.next();
    if (next.done === true) break;
    texts.push(next.value.message.content);
  }
  return texts;
};

const responseTo = (sent: Sent[], id: number) =>
  sent.find((message) => message.id === id);

const turnCompleted = (sent: Sent[]) =>
  sent.find((message) => message.method === "turn/completed")?.params.turn;

const turnsCompleted = (sent: Sent[]) =>
  sent
    .filter((message) => message.method === "turn/completed")
    .map((message) => message.params.turn.status);

const completedItems = (sent: Sent[]) =>
  sent
    .filter((message) => message.method === "item/completed")
    .map((message) => message.params.item);

const sdk = (message: object) =>
  ({
    session_id: "se-1",
    uuid: "uuid-fixture",
    ...message,
  }) as unknown as SDKMessage;

const answer = (id: string, text: string) => ({
  type: "assistant",
  message: { id, content: [{ type: "text", text }], stop_reason: "end_turn" },
  parent_tool_use_id: null,
});

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

// The CLI names the sends a turn took and counts those still queued; leaving them out stands for an older CLI.
const success = (taken?: (string | undefined)[], queued?: number) =>
  result({
    subtype: "success",
    is_error: false,
    result: "done",
    ...(taken !== undefined && { user_message_uuids: taken }),
    ...(queued !== undefined && { queued_turn_count: queued }),
  });

const result = (fields: object) => ({
  type: "result",
  errors: [],
  permission_denials: [],
  ...fields,
});
