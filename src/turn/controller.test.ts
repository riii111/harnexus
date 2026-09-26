import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AccountInfo,
  CanUseTool,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Result } from "better-result";
import { FileWriteFailed, writeFileAtomic } from "../boundary/fs.ts";
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

  test("shows a tool that needed approval as declined", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "clean up"), undefined);
    await until(() => claude.started());
    const canUseTool = claude.options().canUseTool as CanUseTool;
    const decision = await canUseTool(
      "Bash",
      { command: "rm -rf build" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-1",
        requestId: "request-1",
      },
    );
    claude.emit(sdk(bashCall("tool-1")));
    claude.emit(sdk(toolError("tool-1")));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    expect(decision?.behavior).toBe("deny");
    const command = completedItems(sent).find(
      (item) => item.type === "commandExecution",
    );
    expect(command).toMatchObject({ status: "declined" });
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
    {
      name: "plan mode",
      override: {
        collaborationMode: { mode: "plan", settings: { model: MODEL } },
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

  test("refuses a second turn while one is running", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    turns.startTurn(turnStart(11, "again"), undefined);

    expect(responseTo(sent, 11)?.error).toBeDefined();
  });

  test("answers a rejected request with the given message", async () => {
    const { turns, sent } = await harness([]);

    turns.reject({ id: 12 }, "not yet");

    expect(sent).toEqual([
      { id: 12, error: { code: -32600, message: "not yet" } },
    ]);
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

const createGate = () => {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

const THREAD = "th-fixture-1";
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
  }: {
    adopt?: boolean;
    files?: Parameters<typeof openThreadStore>[1];
    beforeStart?: Promise<void>;
    onSend?: (message: Sent) => void;
  } = {},
) => {
  const opened = await openThreadStore(join(dir, "threads.json"), files);
  if (opened.isErr()) return expect.unreachable(opened.error.message);
  const store = opened.value;
  const sent: Sent[] = [];
  const events: TurnEvent[] = [];
  const settings: ClaudeSessionSettings[] = [];
  let turnCount = 0;
  const turns = createTurnController({
    store,
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
  });
  if (adopt) turns.adopt(THREAD, { model: MODEL, cwd: dir });
  return { turns, sent, events, store, settings };
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

const turnStart = (id: number, text: string) => ({
  id,
  params: {
    threadId: THREAD,
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

const interrupt = (id: number, turnId: string) => ({
  id,
  params: { threadId: THREAD, turnId },
});

// Long enough for a turn that was wrongly accepted to reach Claude.
const settle = () => Bun.sleep(20);

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
